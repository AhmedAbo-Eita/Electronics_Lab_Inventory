/**
 * ============================================================================
 * Frontend Auth & Audit Controller
 * ============================================================================
 * Manages the user authentication gate, registration, login sessions,
 * profile chip presentation, and the inventory change audit history modal.
 */

(function () {
  'use strict';

  // Current session user state
  let currentAuthUser = null;
  let auditSearchDebounceTimer = null;
  let currentActionFilter = '';

  // DOM Elements cache
  let dom = {};

  /**
   * Initializes DOM element references once HTML is ready.
   */
  function cacheElements() {
    dom = {
      // Gate Overlay & Forms
      overlay: document.getElementById('authGateOverlay'),
      tabLogin: document.getElementById('authTabLogin'),
      tabRegister: document.getElementById('authTabRegister'),
      feedbackBox: document.getElementById('authFeedbackBox'),
      loginForm: document.getElementById('authLoginForm'),
      registerForm: document.getElementById('authRegisterForm'),
      linkToRegister: document.getElementById('linkToRegister'),
      linkToLogin: document.getElementById('linkToLogin'),

      // Login form inputs
      loginUsername: document.getElementById('loginUsernameInput'),
      loginPassword: document.getElementById('loginPasswordInput'),
      loginSubmitBtn: document.getElementById('authLoginSubmitBtn'),
      toggleLoginPasswordBtn: document.getElementById('toggleLoginPasswordBtn'),

      // Register form inputs
      regUsername: document.getElementById('regUsernameInput'),
      regEmail: document.getElementById('regEmailInput'),
      regPassword: document.getElementById('regPasswordInput'),
      regConfirmPassword: document.getElementById('regConfirmPasswordInput'),
      regSubmitBtn: document.getElementById('authRegisterSubmitBtn'),
      toggleRegPasswordBtn: document.getElementById('toggleRegPasswordBtn'),

      // Top Header User Cluster
      userProfileCluster: document.getElementById('userProfileCluster'),
      openAuditHistoryBtn: document.getElementById('openAuditHistoryBtn'),
      authUserChip: document.getElementById('authUserChip'),
      authUserNameLabel: document.getElementById('authUserNameLabel'),
      authLogoutBtn: document.getElementById('authLogoutBtn'),

      // Audit History Modal
      auditModal: document.getElementById('auditHistoryModal'),
      auditCloseBtn: document.getElementById('auditModalCloseBtn'),
      auditDoneBtn: document.getElementById('auditModalDoneBtn'),
      auditSearchInput: document.getElementById('auditSearchInput'),
      auditSearchClearBtn: document.getElementById('auditSearchClearBtn'),
      auditActionFilters: document.getElementById('auditActionFilters'),
      auditRefreshBtn: document.getElementById('auditRefreshBtn'),
      auditTableBody: document.getElementById('auditTableBody'),
      auditRowCount: document.getElementById('auditRowCount')
    };
  }

  /**
   * Safely escapes HTML special characters to prevent XSS in table displays.
   *
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Formats a database datetime string into a readable local string.
   *
   * @param {string} dateStr
   * @returns {string}
   */
  function formatAuditDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const utcString = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
      const d = new Date(utcString);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Displays an alert or validation message inside the auth feedback box.
   *
   * @param {string} message
   * @param {'error' | 'success'} type
   */
  function showFeedback(message, type = 'error') {
    if (!dom.feedbackBox) return;
    dom.feedbackBox.textContent = message;
    dom.feedbackBox.className = `auth-feedback-box ${type === 'success' ? 'success-banner' : 'error-banner'}`;
    dom.feedbackBox.classList.remove('hidden');
  }

  /**
   * Hides the auth feedback box.
   */
  function clearFeedback() {
    if (!dom.feedbackBox) return;
    dom.feedbackBox.textContent = '';
    dom.feedbackBox.className = 'auth-feedback-box hidden';
  }

  /**
   * Switches between the 'login' and 'register' views.
   *
   * @param {'login' | 'register'} mode
   */
  function switchAuthTab(mode) {
    clearFeedback();
    const isLogin = mode === 'login';

    if (dom.tabLogin && dom.tabRegister) {
      dom.tabLogin.classList.toggle('active', isLogin);
      dom.tabLogin.setAttribute('aria-selected', isLogin ? 'true' : 'false');
      dom.tabRegister.classList.toggle('active', !isLogin);
      dom.tabRegister.setAttribute('aria-selected', !isLogin ? 'true' : 'false');
    }

    if (dom.loginForm && dom.registerForm) {
      dom.loginForm.classList.toggle('hidden', !isLogin);
      dom.registerForm.classList.toggle('hidden', isLogin);
    }

    if (isLogin && dom.loginUsername) {
      dom.loginUsername.focus();
    } else if (!isLogin && dom.regUsername) {
      dom.regUsername.focus();
    }
  }

  /**
   * Toggles the visibility of a password input and switches its eye icons.
   *
   * @param {HTMLInputElement} inputEl
   * @param {HTMLButtonElement} btnEl
   */
  function togglePasswordVisibility(inputEl, btnEl) {
    if (!inputEl || !btnEl) return;
    const isPassword = inputEl.type === 'password';
    inputEl.type = isPassword ? 'text' : 'password';

    const eyeOpen = btnEl.querySelector('.eye-open');
    const eyeClosed = btnEl.querySelector('.eye-closed');
    if (eyeOpen && eyeClosed) {
      eyeOpen.classList.toggle('hidden', isPassword);
      eyeClosed.classList.toggle('hidden', !isPassword);
    }
  }

  /**
   * Updates the UI header chip and overlays to reflect authentication state.
   *
   * @param {Object|null} user
   */
  function setSessionUser(user) {
    currentAuthUser = user;

    if (user && user.username) {
      // User is logged in
      if (dom.authUserNameLabel) {
        dom.authUserNameLabel.textContent = user.username;
      }
      if (dom.authUserChip) {
        const lastLoginStr = user.lastLogin ? formatAuditDate(user.lastLogin) : 'First login';
        const lastFailedStr = user.lastFailedLogin ? formatAuditDate(user.lastFailedLogin) : 'None';
        dom.authUserChip.title = `Logged in as: ${user.username}\nEmail: ${user.email || 'N/A'}\nLast login: ${lastLoginStr}\nLast failed attempt: ${lastFailedStr}`;
      }
      if (dom.userProfileCluster) {
        dom.userProfileCluster.classList.remove('hidden');
      }
      if (dom.overlay) {
        dom.overlay.classList.add('hidden');
      }
    } else {
      // Logged out
      if (dom.userProfileCluster) {
        dom.userProfileCluster.classList.add('hidden');
      }
      if (dom.authUserNameLabel) {
        dom.authUserNameLabel.textContent = 'Guest';
      }
      if (dom.authUserChip) {
        dom.authUserChip.title = 'Not authenticated';
      }
      if (dom.overlay) {
        dom.overlay.classList.remove('hidden');
      }
      switchAuthTab('login');
    }

    // Trigger external notification for other modules (e.g. renderer.js)
    if (typeof window.onAuthStateChanged === 'function') {
      window.onAuthStateChanged(currentAuthUser);
    }
  }

  /**
   * Handles user login submission.
   */
  async function handleLoginSubmit() {
    clearFeedback();
    const username = (dom.loginUsername ? dom.loginUsername.value : '').trim();
    const password = dom.loginPassword ? dom.loginPassword.value : '';

    if (!username) {
      showFeedback('Please enter your username or email.');
      if (dom.loginUsername) dom.loginUsername.focus();
      return;
    }
    if (!password) {
      showFeedback('Please enter your password.');
      if (dom.loginPassword) dom.loginPassword.focus();
      return;
    }

    if (!window.electronAPI || !window.electronAPI.loginUser) {
      showFeedback('Authentication service is not available.');
      return;
    }

    const submitBtn = dom.loginSubmitBtn;
    if (submitBtn) {
      submitBtn.disabled = true;
      const textSpan = submitBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Signing In...';
    }

    try {
      const res = await window.electronAPI.loginUser({ username, password });
      if (!res.ok) {
        showFeedback(res.error || 'Login failed. Please check your credentials.');
        if (dom.loginPassword) {
          dom.loginPassword.value = '';
          dom.loginPassword.focus();
        }
        return;
      }

      // Success
      setSessionUser(res.user);
      if (dom.loginPassword) dom.loginPassword.value = '';
    } catch (err) {
      showFeedback(`Login error: ${err.message}`);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        const textSpan = submitBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = 'Sign In';
      }
    }
  }

  /**
   * Handles new user registration submission.
   */
  async function handleRegisterSubmit() {
    clearFeedback();
    const username = (dom.regUsername ? dom.regUsername.value : '').trim();
    const email = (dom.regEmail ? dom.regEmail.value : '').trim();
    const password = dom.regPassword ? dom.regPassword.value : '';
    const confirmPassword = dom.regConfirmPassword ? dom.regConfirmPassword.value : '';

    // Validation
    if (!username || username.length < 3) {
      showFeedback('Username must be at least 3 characters long.');
      if (dom.regUsername) dom.regUsername.focus();
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      showFeedback('Please enter a valid email address.');
      if (dom.regEmail) dom.regEmail.focus();
      return;
    }
    if (!password || password.length < 4) {
      showFeedback('Password must be at least 4 characters long.');
      if (dom.regPassword) dom.regPassword.focus();
      return;
    }
    if (password !== confirmPassword) {
      showFeedback('Passwords do not match. Please re-type your password.');
      if (dom.regConfirmPassword) dom.regConfirmPassword.focus();
      return;
    }

    if (!window.electronAPI || !window.electronAPI.registerUser) {
      showFeedback('Authentication service is not available.');
      return;
    }

    const submitBtn = dom.regSubmitBtn;
    if (submitBtn) {
      submitBtn.disabled = true;
      const textSpan = submitBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Creating Account...';
    }

    try {
      const res = await window.electronAPI.registerUser({ username, email, password });
      if (!res.ok) {
        showFeedback(res.error || 'Registration failed.');
        return;
      }

      // Success - user is registered and logged in
      setSessionUser(res.user);
      if (dom.regPassword) dom.regPassword.value = '';
      if (dom.regConfirmPassword) dom.regConfirmPassword.value = '';
    } catch (err) {
      showFeedback(`Registration error: ${err.message}`);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        const textSpan = submitBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = 'Create Account';
      }
    }
  }

  /**
   * Prompts user and logs out the current session.
   */
  async function handleLogout() {
    let proceed = false;
    if (typeof window.showAppDialog === 'function') {
      const { response } = await window.showAppDialog({
        type: 'logout',
        icon: 'logout',
        buttons: ['Sign Out', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Sign Out Session',
        message: 'Are you sure you want to sign out? You will need your password to log back in.'
      });
      proceed = response === 0;
    } else {
      proceed = window.confirm('Are you sure you want to sign out?');
    }

    if (!proceed) return;

    try {
      if (window.electronAPI && window.electronAPI.logoutUser) {
        await window.electronAPI.logoutUser();
      }
    } catch (err) {
      console.warn('Logout notice:', err.message);
    }

    setSessionUser(null);
    if (dom.loginPassword) dom.loginPassword.value = '';
  }

  /**
   * Fetches and renders audit history log entries with optional action filter.
   *
   * @param {string} [search]
   * @param {string} [actionFilter]
   */
  async function loadAuditHistory(search = '', actionFilter = currentActionFilter) {
    if (!dom.auditTableBody) return;
    if (!window.electronAPI || !window.electronAPI.getAuditHistory) {
      dom.auditTableBody.innerHTML = '<tr><td colspan="5" class="audit-empty-row">Audit service unavailable.</td></tr>';
      return;
    }

    const searchVal = search !== undefined ? search : (dom.auditSearchInput ? dom.auditSearchInput.value : '');
    if (dom.auditSearchClearBtn) {
      dom.auditSearchClearBtn.classList.toggle('hidden', !searchVal || searchVal.trim().length === 0);
    }

    dom.auditTableBody.innerHTML = '<tr><td colspan="5" class="audit-empty-row">Loading audit records...</td></tr>';

    try {
      const res = await window.electronAPI.getAuditHistory({
        limit: 150,
        search: searchVal.trim(),
        action: actionFilter || ''
      });

      if (!res.ok || !Array.isArray(res.rows)) {
        dom.auditTableBody.innerHTML = `<tr><td colspan="5" class="audit-empty-row">Failed to load history: ${escapeHtml(res.error || 'Unknown error')}</td></tr>`;
        if (dom.auditRowCount) dom.auditRowCount.textContent = 'Showing 0 entries';
        return;
      }

      let rows = res.rows;
      if (actionFilter) {
        rows = rows.filter((r) => {
          const act = (r.action_type || r.actionType || '').toUpperCase();
          return act === actionFilter.toUpperCase();
        });
      }

      if (rows.length === 0) {
        const filterMsg = actionFilter ? ` with action "${escapeHtml(actionFilter)}"` : '';
        const searchMsg = searchVal.trim() ? ` matching "${escapeHtml(searchVal.trim())}"` : '';
        dom.auditTableBody.innerHTML = `<tr><td colspan="5" class="audit-empty-row">No change history recorded${filterMsg}${searchMsg}.</td></tr>`;
        if (dom.auditRowCount) dom.auditRowCount.textContent = 'Showing 0 entries';
        return;
      }

      const html = rows.map((row) => {
        const action = (row.action_type || row.actionType || 'UNKNOWN').toUpperCase();
        const actionClass = `audit-action-${action.toLowerCase()}`;
        const dateStr = formatAuditDate(row.changed_at || row.changedAt);
        const userStr = escapeHtml(row.username || 'Anonymous');
        const mpnStr = escapeHtml(row.mpn || '—');
        const detailsStr = escapeHtml(row.change_details || row.changeDetails || '');

        return `<tr>
          <td class="audit-date-cell">${dateStr}</td>
          <td class="audit-user-cell"><span class="audit-user-badge">${userStr}</span></td>
          <td class="audit-action-cell"><span class="audit-action-pill ${actionClass}">${escapeHtml(action)}</span></td>
          <td class="audit-mpn-cell"><code>${mpnStr}</code></td>
          <td class="audit-details-cell">${detailsStr}</td>
        </tr>`;
      }).join('');

      dom.auditTableBody.innerHTML = html;
      if (dom.auditRowCount) {
        const filterBadge = actionFilter ? ` [${escapeHtml(actionFilter)}]` : '';
        dom.auditRowCount.textContent = `Showing ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${filterBadge}${searchVal.trim() ? ` matching "${escapeHtml(searchVal.trim())}"` : ''}`;
      }
    } catch (err) {
      dom.auditTableBody.innerHTML = `<tr><td colspan="5" class="audit-empty-row">Error loading history: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  /**
   * Opens the audit history modal and loads records.
   */
  function openAuditHistoryModal() {
    if (!dom.auditModal) return;
    dom.auditModal.classList.remove('hidden');

    currentActionFilter = '';
    if (dom.auditActionFilters) {
      dom.auditActionFilters.querySelectorAll('.audit-filter-chip').forEach((chip) => {
        chip.classList.toggle('active', (chip.getAttribute('data-action') || '') === '');
      });
    }

    if (dom.auditSearchInput) {
      dom.auditSearchInput.value = '';
      dom.auditSearchInput.focus();
    }
    if (dom.auditSearchClearBtn) {
      dom.auditSearchClearBtn.classList.add('hidden');
    }

    loadAuditHistory('', '');
  }

  /**
   * Closes the audit history modal.
   */
  function closeAuditHistoryModal() {
    if (!dom.auditModal) return;
    dom.auditModal.classList.add('hidden');
  }

  /**
   * Binds all DOM event listeners.
   */
  function setupEventListeners() {
    // Mode Pills
    if (dom.tabLogin) {
      dom.tabLogin.addEventListener('click', () => switchAuthTab('login'));
    }
    if (dom.tabRegister) {
      dom.tabRegister.addEventListener('click', () => switchAuthTab('register'));
    }
    if (dom.linkToRegister) {
      dom.linkToRegister.addEventListener('click', () => switchAuthTab('register'));
    }
    if (dom.linkToLogin) {
      dom.linkToLogin.addEventListener('click', () => switchAuthTab('login'));
    }

    // Password Visibility Toggles
    if (dom.toggleLoginPasswordBtn) {
      dom.toggleLoginPasswordBtn.addEventListener('click', () => {
        togglePasswordVisibility(dom.loginPassword, dom.toggleLoginPasswordBtn);
      });
    }
    if (dom.toggleRegPasswordBtn) {
      dom.toggleRegPasswordBtn.addEventListener('click', () => {
        togglePasswordVisibility(dom.regPassword, dom.toggleRegPasswordBtn);
      });
    }

    // Submit actions
    if (dom.loginSubmitBtn) {
      dom.loginSubmitBtn.addEventListener('click', handleLoginSubmit);
    }
    if (dom.regSubmitBtn) {
      dom.regSubmitBtn.addEventListener('click', handleRegisterSubmit);
    }

    // Enter key submits for forms
    if (dom.loginForm) {
      dom.loginForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleLoginSubmit();
        }
      });
    }
    if (dom.registerForm) {
      dom.registerForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleRegisterSubmit();
        }
      });
    }

    // Header buttons
    if (dom.authLogoutBtn) {
      dom.authLogoutBtn.addEventListener('click', handleLogout);
    }
    if (dom.authUserChip) {
      dom.authUserChip.style.cursor = 'pointer';
      dom.authUserChip.addEventListener('click', () => {
        if (typeof window.openSettingsModal === 'function') {
          window.openSettingsModal('account');
        }
      });
    }
    if (dom.openAuditHistoryBtn) {
      dom.openAuditHistoryBtn.addEventListener('click', openAuditHistoryModal);
    }

    // Audit Modal Controls
    if (dom.auditCloseBtn) {
      dom.auditCloseBtn.addEventListener('click', closeAuditHistoryModal);
    }
    if (dom.auditDoneBtn) {
      dom.auditDoneBtn.addEventListener('click', closeAuditHistoryModal);
    }
    if (dom.auditRefreshBtn) {
      dom.auditRefreshBtn.addEventListener('click', () => {
        loadAuditHistory(dom.auditSearchInput ? dom.auditSearchInput.value : '', currentActionFilter);
      });
    }

    // Search input and clear button
    if (dom.auditSearchInput) {
      dom.auditSearchInput.addEventListener('input', () => {
        const val = dom.auditSearchInput.value;
        if (dom.auditSearchClearBtn) {
          dom.auditSearchClearBtn.classList.toggle('hidden', !val || val.trim().length === 0);
        }
        clearTimeout(auditSearchDebounceTimer);
        auditSearchDebounceTimer = setTimeout(() => {
          loadAuditHistory(dom.auditSearchInput.value, currentActionFilter);
        }, 220);
      });
    }

    if (dom.auditSearchClearBtn) {
      dom.auditSearchClearBtn.addEventListener('click', () => {
        if (dom.auditSearchInput) {
          dom.auditSearchInput.value = '';
          dom.auditSearchInput.focus();
        }
        dom.auditSearchClearBtn.classList.add('hidden');
        loadAuditHistory('', currentActionFilter);
      });
    }

    // Action filter chips
    if (dom.auditActionFilters) {
      dom.auditActionFilters.addEventListener('click', (e) => {
        const chip = e.target.closest('.audit-filter-chip');
        if (!chip) return;
        const action = chip.getAttribute('data-action') || '';
        currentActionFilter = action;

        dom.auditActionFilters.querySelectorAll('.audit-filter-chip').forEach((c) => {
          c.classList.toggle('active', c === chip);
        });

        const search = dom.auditSearchInput ? dom.auditSearchInput.value : '';
        loadAuditHistory(search, currentActionFilter);
      });
    }

    // Close audit modal on backdrop click or ESC
    if (dom.auditModal) {
      dom.auditModal.addEventListener('click', (e) => {
        if (e.target === dom.auditModal) {
          closeAuditHistoryModal();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (dom.auditModal && !dom.auditModal.classList.contains('hidden')) {
          closeAuditHistoryModal();
        }
      }
    });
  }

  /**
   * Initializes the authentication gate on application start.
   */
  async function initAuth() {
    cacheElements();
    setupEventListeners();

    if (!window.electronAPI || !window.electronAPI.getCurrentUser) {
      console.warn('Electron API auth methods not detected.');
      return;
    }

    try {
      const activeUser = await window.electronAPI.getCurrentUser();
      setSessionUser(activeUser);
    } catch (err) {
      console.error('Failed to get current user:', err);
      setSessionUser(null);
    }
  }

  // Self-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }

  // Export public methods for pair programming and inter-script coordination
  window.authController = {
    getCurrentUser: () => currentAuthUser,
    openAuditHistory: openAuditHistoryModal,
    loadAuditHistory,
    setSessionUser
  };
})();
