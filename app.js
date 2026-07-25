// Initialize Firebase (compat SDK — global `firebase` from CDN)
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// Configure Firebase Authentication to use Session Persistence
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
  .then(() => {
    console.log('🔥 Firebase Auth persistence set to SESSION');
  })
  .catch((err) => {
    console.error('❌ Failed to set Firebase Auth persistence:', err);
  });

// Enable offline persistence
db.enablePersistence().catch((err) => {
  if (err.code === 'failed-precondition') {
    console.warn('Firestore persistence failed: Multiple tabs open.');
  } else if (err.code === 'unimplemented') {
    console.warn('Firestore persistence not available in this browser.');
  }
});

// ============================================================
// APPLICATION STATE
// ============================================================
const APP = {
  members: [],
  sessions: [],
  attendance: {},       // { memberId: { status, reason, remarks } }
  currentTab: 'dashboard',
  editingMemberId: null,
  editingSessionId: null, // Track currently edited attendance session
  removedMemberIds: new Set(), // Track member IDs excluded from the current session
  currentReportSession: null,
  confirmCallback: null,
  userRole: null,       // Loaded role for the current logged-in user
  userRoles: [],        // List of all user roles for admin display
  editingUserRoleEmail: null,

  // Google Drive state
  googleAccessToken: null,
  googleTokenExpiry: null,
  driveSettings: null
};

// ============================================================
// DOM HELPERS
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initNavigation();
  initAuthListener();
  setDefaultDate();

  // Service type "Other" toggle
  const serviceSelect = $('#attendance-service');
  if (serviceSelect) {
    serviceSelect.addEventListener('change', () => {
      const wrapper = $('#custom-service-wrapper');
      if (wrapper) {
        if (serviceSelect.value === 'Other') {
          wrapper.classList.remove('hidden');
          $('#attendance-service-custom')?.focus();
        } else {
          wrapper.classList.add('hidden');
          if ($('#attendance-service-custom')) $('#attendance-service-custom').value = '';
        }
      }
    });
  }
});

function setDefaultDate() {
  const dateInput = $('#attendance-date');
  if (dateInput) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  const timeInput = $('#attendance-time');
  if (timeInput) {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    timeInput.value = `${hours}:${minutes}`;
  }
}

// ============================================================
// AUTHENTICATION
// ============================================================
function initAuthListener() {
  if (typeof auth === 'undefined' || !auth) {
    console.error('Firebase Auth service is not defined. Please check your firebase-config.js configuration.');
    const preloaderText = $('.preloader-text');
    if (preloaderText) {
      preloaderText.innerHTML = '<span style="color:var(--danger); font-weight:600;">Configuration Error: Firebase Auth is not defined.<br>Please set up your GitHub repository Secrets and push code to trigger the build.</span>';
      // Stop spinner animation to indicate error
      const spinner = $('.preloader-spinner');
      if (spinner) spinner.style.borderTopColor = 'var(--danger)';
    }
    return;
  }
  auth.onAuthStateChanged(async (user) => {
    const preloader = $('#preloader');
    const preloaderText = $('.preloader-text');
    if (user) {
      if (preloaderText) preloaderText.textContent = 'Verifying access credentials...';
      try {
        const roleData = await checkUserRole(user);
        if (roleData) {
          if (roleData.active === false) {
            // Explicitly Deactivated
            $('#login-screen').classList.add('hidden');
            $('#app').classList.add('hidden');
            $('#blocked-screen').classList.remove('hidden');
            $('#blocked-user-email').textContent = user.email;
          } else {
            APP.userRole = roleData;

            // Render badge
            const roleDisplay = $('#user-role-display');
            const roleIcon = $('#user-role-icon');
            const roleBadge = $('#user-role-badge');

            if (roleDisplay) {
              roleDisplay.textContent = roleData.accessMode === 'admin'
                ? (roleData.clubPosition || 'Admin')
                : 'Viewer';
            }

            if (roleBadge) {
              if (roleData.accessMode === 'admin') {
                roleBadge.style.background = 'var(--accent-bg)';
                roleBadge.style.color = 'var(--accent-dark)';
                roleBadge.style.border = '1px solid var(--accent)';
                if (roleIcon) roleIcon.className = 'fas fa-user-shield';
              } else {
                roleBadge.style.background = 'rgba(100, 100, 100, 0.08)';
                roleBadge.style.color = 'var(--text-secondary)';
                roleBadge.style.border = '1px solid var(--border)';
                if (roleIcon) roleIcon.className = 'fas fa-user-tie';
              }
            }

            // Enforce navigation views
            applyAccessControlRules();

            // Transition screen
            $('#login-screen').classList.add('hidden');
            $('#blocked-screen').classList.add('hidden');
            $('#app').classList.remove('hidden');
            $('#settings-admin-email').textContent = user.email;

            await loadAppData();
          }
        } else {
          // Fallback guest viewer mode
          APP.userRole = null;
          applyAccessControlRules();
          $('#login-screen').classList.add('hidden');
          $('#blocked-screen').classList.add('hidden');
          $('#app').classList.remove('hidden');
          await loadAppData();
        }
      } catch (err) {
        console.error('Error verifying user role:', err);
        showToast('Failed to verify access role.', 'error');
        await auth.signOut();
      }
    } else {
      // User is signed out -> default to VIEWER MODE
      APP.userRole = null;
      applyAccessControlRules();
      $('#login-screen').classList.add('hidden');
      $('#blocked-screen').classList.add('hidden');
      $('#app').classList.remove('hidden');
      switchTab('dashboard');
      await loadAppData();
    }

    // Hide preloader
    const hasSeenIntro = sessionStorage.getItem('hasSeenIntro') === 'true';
    const dismissDelay = hasSeenIntro ? 0 : 500;

    setTimeout(() => {
      if (preloader) {
        if (hasSeenIntro) {
          preloader.remove();
        } else {
          preloader.classList.add('fade-out');
          setTimeout(() => preloader.remove(), 400);
          sessionStorage.setItem('hasSeenIntro', 'true');
        }
      }
    }, dismissDelay);
  });

  // Login form
  $('#login-form').addEventListener('submit', handleLogin);
  // Logout button
  $('#logout-btn').addEventListener('click', handleLogout);

  // Admin Access button trigger
  $('#admin-access-btn')?.addEventListener('click', () => {
    $('#login-screen').classList.remove('hidden');
    $('#login-error').textContent = '';
    $('#login-email').value = '';
    $('#login-password').value = '';
    setTimeout(() => $('#login-email')?.focus(), 100);
  });

  // Login Cancel button trigger
  $('#login-cancel-btn')?.addEventListener('click', () => {
    $('#login-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    switchTab('dashboard');
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const errorEl = $('#login-error');
  const btn = $('#login-btn');

  if (!email || !password) {
    errorEl.textContent = 'Please enter email and password.';
    return;
  }

  btn.disabled = true;
  btn.querySelector('.login-btn-text').textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    let message = 'Login failed. Please try again.';
    if (err.code === 'auth/user-not-found') message = 'No account found with this email.';
    else if (err.code === 'auth/wrong-password') message = 'Incorrect password.';
    else if (err.code === 'auth/invalid-email') message = 'Invalid email address.';
    else if (err.code === 'auth/too-many-requests') message = 'Too many attempts. Try again later.';
    else if (err.code === 'auth/invalid-credential') message = 'Invalid credentials. Check email & password.';
    errorEl.textContent = message;
  } finally {
    btn.disabled = false;
    btn.querySelector('.login-btn-text').textContent = 'Sign In';
  }
}

async function handleLogout() {
  showConfirm('Sign Out', 'Are you sure you want to log out?', async () => {
    try {
      await auth.signOut();
      showToast('Signed out successfully', 'info');
    } catch (err) {
      showToast('Logout failed', 'error');
    }
  });
}

// ============================================================
// DATA LOADING
// ============================================================
let membersUnsubscribe = null;
let sessionsUnsubscribe = null;

async function loadAppData() {
  try {
    const promises = [];

    // Set up real-time listener for members
    if (membersUnsubscribe) membersUnsubscribe();
    const membersPromise = new Promise((resolve) => {
      membersUnsubscribe = db.collection('members')
        .orderBy('name')
        .onSnapshot((snapshot) => {
          APP.members = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderMembersList();
          renderAttendanceLists();
          renderDashboard();
          resolve();
        }, (err) => {
          console.error('Real-time members listener error:', err);
          resolve();
        });
    });
    promises.push(membersPromise);

    // Set up real-time listener for sessions
    if (sessionsUnsubscribe) sessionsUnsubscribe();
    const sessionsPromise = new Promise((resolve) => {
      sessionsUnsubscribe = db.collection('sessions')
        .orderBy('date', 'desc')
        .onSnapshot((snapshot) => {
          APP.sessions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderReportsList();
          renderDashboard();
          updateSettingsCounts();
          resolve();
        }, (err) => {
          console.error('Real-time sessions listener error:', err);
          resolve();
        });
    });
    promises.push(sessionsPromise);

    // Admin-only data fetches
    if (APP.userRole && APP.userRole.accessMode === 'admin') {
      promises.push(fetchUserRoles().then(() => renderUserRoles()));
      promises.push(fetchDriveSettings().then(() => initGoogleClient()));
    }

    await Promise.all(promises);
  } catch (err) {
    console.error('Error loading data:', err);
    showToast('Failed to load data. Check your connection.', 'error');
  }
}

async function fetchMembers() {
  try {
    const snapshot = await db.collection('members').orderBy('name').get();
    APP.members = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error('Error fetching members:', err);
    throw err;
  }
}

async function fetchSessions() {
  try {
    const snapshot = await db.collection('sessions').orderBy('date', 'desc').get();
    APP.sessions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error('Error fetching sessions:', err);
    throw err;
  }
}

// ============================================================
// THEME
// ============================================================
function initTheme() {
  const saved = localStorage.getItem('rotaract-theme') || 'dark';
  applyTheme(saved);

  $('#theme-toggle-btn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('rotaract-theme', next);
  });

  $('#theme-switch-input').addEventListener('change', (e) => {
    const next = e.target.checked ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('rotaract-theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = $('#theme-icon');
  if (icon) {
    icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  }
  const switchInput = $('#theme-switch-input');
  if (switchInput) {
    switchInput.checked = theme === 'dark';
  }
}

// ============================================================
// NAVIGATION
// ============================================================
function initNavigation() {
  // Desktop tabs
  $$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  // Mobile tabs
  $$('.mobile-nav-item').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tabName) {
  const mode = APP.userRole ? APP.userRole.accessMode : 'viewer';
  if (mode !== 'admin' && ['attendance', 'members', 'settings'].includes(tabName)) {
    showToast('Access Denied: You do not have permission to view this section.', 'warning');
    return;
  }

  APP.currentTab = tabName;

  // Update tab buttons
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.mobile-nav-item').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

  // Update tab content
  $$('.tab-content').forEach(section => {
    section.classList.toggle('active', section.id === `${tabName}-tab`);
  });

  // Refresh content for the active tab
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'reports') renderReportsList();
  if (tabName === 'members') renderMembersList();
  if (tabName === 'attendance') renderAttendanceLists();
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info', title = '') {
  const container = $('#toast-container');
  const icons = {
    success: 'fa-check-circle',
    error: 'fa-exclamation-circle',
    warning: 'fa-exclamation-triangle',
    info: 'fa-info-circle'
  };
  const titles = {
    success: 'Success',
    error: 'Error',
    warning: 'Warning',
    info: 'Info'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fas ${icons[type]} toast-icon"></i>
    <div class="toast-content">
      <div class="toast-title">${title || titles[type]}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.classList.add('toast-exit'); setTimeout(()=>this.parentElement.remove(),300);">&times;</button>
  `;

  container.appendChild(toast);

  // Auto remove after 4 seconds
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }
  }, 4000);
}

// ============================================================
// CONFIRM DIALOG
// ============================================================
function showConfirm(title, message, onConfirm, type = 'warning') {
  const modal = $('#confirm-modal');
  const iconEl = $('#confirm-icon');
  const msgEl = $('#confirm-message');
  const subMsgEl = $('#confirm-sub-message');
  const okBtn = $('#confirm-ok-btn');

  msgEl.textContent = title;
  subMsgEl.textContent = message;
  iconEl.className = `confirm-icon ${type}`;
  iconEl.innerHTML = type === 'danger'
    ? '<i class="fas fa-trash-alt"></i>'
    : '<i class="fas fa-exclamation-triangle"></i>';

  okBtn.className = type === 'danger' ? 'btn btn-danger' : 'btn btn-danger';
  okBtn.textContent = 'Confirm';

  APP.confirmCallback = onConfirm;
  okBtn.onclick = () => {
    hideModal('confirm-modal');
    if (APP.confirmCallback) APP.confirmCallback();
    APP.confirmCallback = null;
  };

  showModal('confirm-modal');
}

// ============================================================
// MODAL HELPERS
// ============================================================
function showModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.classList.add('active');
}

function hideModal(id) {
  const modal = $(`#${id}`);
  if (modal) modal.classList.remove('active');
}

// Close modals on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});

// ============================================================
// MEMBERS MODULE
// ============================================================

function getMembersByCategory(category) {
  return APP.members.filter(m => m.category === category);
}

function openAddMemberModal(presetCategory = '') {
  APP.editingMemberId = null;
  $('#member-modal-title').textContent = 'Add Member';
  $('#member-save-btn').innerHTML = '<i class="fas fa-save"></i> Save Member';
  $('#member-form').reset();
  $('#member-edit-id').value = '';
  if (presetCategory) {
    $('#member-category-input').value = presetCategory;
  }
  showModal('member-modal');
  setTimeout(() => $('#member-name-input').focus(), 200);
}

function openEditMemberModal(memberId) {
  const member = APP.members.find(m => m.id === memberId);
  if (!member) return;

  APP.editingMemberId = memberId;
  $('#member-modal-title').textContent = 'Edit Member';
  $('#member-save-btn').innerHTML = '<i class="fas fa-save"></i> Update Member';
  $('#member-edit-id').value = memberId;
  $('#member-name-input').value = member.name || '';
  $('#member-category-input').value = member.category || '';
  $('#member-role-input').value = member.role || '';
  $('#member-dept-input').value = member.department || '';
  $('#member-year-input').value = member.year || '';
  $('#member-phone-input').value = member.phone || '';
  $('#member-email-input').value = member.email || '';

  showModal('member-modal');
  setTimeout(() => $('#member-name-input').focus(), 200);
}

async function saveMember() {
  const name = $('#member-name-input').value.trim();
  const category = $('#member-category-input').value;
  const role = $('#member-role-input').value.trim();
  const department = $('#member-dept-input').value.trim();
  const year = $('#member-year-input').value.trim();
  const phone = $('#member-phone-input').value.trim();
  const email = $('#member-email-input').value.trim();

  // Validation
  if (!name) {
    showToast('Please enter a full name.', 'warning');
    $('#member-name-input').focus();
    return;
  }
  if (!category) {
    showToast('Please select a category.', 'warning');
    $('#member-category-input').focus();
    return;
  }

  // Normalize name for duplicate check
  const normalizedName = name.toLowerCase().trim();

  // Check for duplicates (same name + category, excluding current edit)
  const duplicate = APP.members.find(m =>
    m.name.toLowerCase().trim() === normalizedName &&
    m.category === category &&
    m.id !== APP.editingMemberId
  );

  if (duplicate) {
    showToast(`"${name}" already exists in ${category} category.`, 'warning');
    return;
  }

  const memberData = {
    name,
    category,
    role,
    department,
    year,
    phone,
    email,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    if (APP.editingMemberId) {
      // Update existing member
      await db.collection('members').doc(APP.editingMemberId).update(memberData);
      showToast(`${name} updated successfully.`, 'success');
    } else {
      // Add new member
      memberData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection('members').add(memberData);
      showToast(`${name} added successfully.`, 'success');
    }

    hideModal('member-modal');
    await fetchMembers();
    renderMembersList();
    renderAttendanceLists();
    renderDashboard();
    updateSettingsCounts();

  } catch (err) {
    console.error('Error saving member:', err);
    showToast('Failed to save member. Please try again.', 'error');
  }
}

function deleteMember(memberId) {
  const member = APP.members.find(m => m.id === memberId);
  if (!member) return;

  showConfirm(
    `Delete "${member.name}"?`,
    'This will remove the member from the database. Past attendance records will be preserved.',
    async () => {
      try {
        await db.collection('members').doc(memberId).delete();
        showToast(`${member.name} deleted.`, 'success');
        await fetchMembers();
        renderMembersList();
        renderAttendanceLists();
        renderDashboard();
        updateSettingsCounts();
      } catch (err) {
        console.error('Error deleting member:', err);
        showToast('Failed to delete member.', 'error');
      }
    },
    'danger'
  );
}

// ---- Render Members List ----
function renderMembersList() {
  const searchQuery = ($('#member-search')?.value || '').toLowerCase();
  const filterCategory = $('#member-category-filter')?.value || 'all';

  let filtered = APP.members;

  if (filterCategory !== 'all') {
    filtered = filtered.filter(m => m.category === filterCategory);
  }

  if (searchQuery) {
    filtered = filtered.filter(m =>
      (m.name || '').toLowerCase().includes(searchQuery) ||
      (m.role || '').toLowerCase().includes(searchQuery) ||
      (m.department || '').toLowerCase().includes(searchQuery) ||
      (m.email || '').toLowerCase().includes(searchQuery)
    );
  }

  // Render category chips
  renderMemberChips();

  // Group filtered members by category
  const boardMembers = filtered.filter(m => m.category === 'Board Official');
  const rotaractorMembers = filtered.filter(m => m.category === 'Rotaractor');
  const otherMembers = filtered.filter(m => m.category === 'Other Rotaractor');

  // Helper to render grid list
  const renderGridContent = (members, containerId, categoryName) => {
    const container = $(`#${containerId}`);
    if (!container) return;

    if (members.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1; padding: 24px;">
          <p style="color:var(--text-tertiary); font-size:0.85rem;">No ${categoryName.toLowerCase()}s found</p>
        </div>`;
      return;
    }

    container.innerHTML = members.map(m => {
      const avatarClass = m.category === 'Board Official' ? 'board'
        : m.category === 'Rotaractor' ? 'rotaractor' : 'other';
      const badgeClass = m.category === 'Board Official' ? 'badge-board'
        : m.category === 'Rotaractor' ? 'badge-rotaractor' : 'badge-other';
      const initials = (m.name || 'U').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

      return `
        <div class="member-card">
          <div class="member-avatar ${avatarClass}">${initials}</div>
          <div class="member-info">
            <div class="member-name">${escapeHtml(m.name)}</div>
            <div class="member-role">${escapeHtml(m.role || 'Member')} <span class="badge ${badgeClass}">${m.category === 'Rotaractor' ? 'Green Rotaractor' : (m.category === 'Other Rotaractor' ? 'Rotaractor' : m.category)}</span></div>
            ${m.department || m.year ? `<div class="member-details">${escapeHtml(m.department || '')}${m.department && m.year ? ' · ' : ''}${escapeHtml(m.year || '')}</div>` : ''}
          </div>
          <div class="member-actions">
            <button class="btn-icon" onclick="openEditMemberModal('${m.id}')" title="Edit"><i class="fas fa-pen"></i></button>
            <button class="btn-icon danger" onclick="deleteMember('${m.id}')" title="Delete"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>`;
    }).join('');
  };

  // Render each section
  renderGridContent(boardMembers, 'board-officials-grid', 'Board Official');
  renderGridContent(rotaractorMembers, 'rotaractors-grid', 'Green Rotaractor');
  renderGridContent(otherMembers, 'other-rotaractors-grid', 'Rotaractor');

  // Show/hide sections based on filter and counts
  const toggleSection = (sectionId, count, category) => {
    const section = $(`#${sectionId}`);
    if (!section) return;

    const isVisible = (filterCategory === 'all' || filterCategory === category) &&
      (searchQuery ? count > 0 : true);

    if (isVisible) {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  };

  toggleSection('members-board-section', boardMembers.length, 'Board Official');
  toggleSection('members-rotaractor-section', rotaractorMembers.length, 'Rotaractor');
  toggleSection('members-other-section', otherMembers.length, 'Other Rotaractor');

  // Update counts on headers
  const boardCountEl = $('#members-board-count');
  if (boardCountEl) animateCounter(boardCountEl, boardMembers.length);

  const rotaractorCountEl = $('#members-rotaractor-count');
  if (rotaractorCountEl) animateCounter(rotaractorCountEl, rotaractorMembers.length);

  const otherCountEl = $('#members-other-count');
  if (otherCountEl) animateCounter(otherCountEl, otherMembers.length);

  // Manage general empty state
  const totalCount = boardMembers.length + rotaractorMembers.length + otherMembers.length;
  const emptyStateEl = $('#members-empty-state');
  if (totalCount === 0) {
    if (!emptyStateEl) {
      const el = document.createElement('div');
      el.id = 'members-empty-state';
      el.className = 'empty-state';
      el.innerHTML = `
        <div class="empty-state-icon"><i class="fas fa-users-slash"></i></div>
        <h3>No members found</h3>
        <p>${searchQuery ? 'Try a different search term' : 'Add your first member to get started'}</p>
      `;
      $('#members-tab').appendChild(el);
    } else {
      emptyStateEl.classList.remove('hidden');
    }
  } else {
    if (emptyStateEl) emptyStateEl.classList.add('hidden');
  }
}

function renderMemberChips() {
  const container = $('#member-category-chips');
  const boardCount = APP.members.filter(m => m.category === 'Board Official').length;
  const rotaractorCount = APP.members.filter(m => m.category === 'Rotaractor').length;
  const otherCount = APP.members.filter(m => m.category === 'Other Rotaractor').length;

  container.innerHTML = `
    <div class="chip"><i class="fas fa-users"></i> All Members <span class="chip-count">${APP.members.length}</span></div>
    <div class="chip board"><i class="fas fa-user-tie"></i> Board Officials <span class="chip-count">${boardCount}</span></div>
    <div class="chip rotaractor"><i class="fas fa-user"></i> Green Rotaractors <span class="chip-count">${rotaractorCount}</span></div>
    <div class="chip other"><i class="fas fa-user-friends"></i> Rotaractors <span class="chip-count">${otherCount}</span></div>
  `;
}

// ---- Excel Import & Template Feature ----
let importState = {
  validMembers: [],
  duplicateCount: 0,
  invalidCount: 0,
  skippedCount: 0,
  targetCategory: '',
  startTime: null
};

function triggerImportExcel(category) {
  importState.targetCategory = category;

  let fileInput = $('#member-excel-input');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'member-excel-input';
    fileInput.accept = '.xlsx, .xls';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleExcelFileSelect);
    document.body.appendChild(fileInput);
  }

  fileInput.value = '';
  fileInput.click();
}

function handleExcelFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const extension = file.name.split('.').pop().toLowerCase();
  if (extension !== 'xlsx' && extension !== 'xls') {
    showToast('Invalid file format. Please select an Excel file (.xlsx or .xls)', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
      processImportData(rows);
    } catch (err) {
      console.error('SheetJS parse failed:', err);
      showToast('Failed to parse Excel file. Ensure file is not corrupted.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function processImportData(rows) {
  importState.validMembers = [];
  importState.duplicateCount = 0;
  importState.invalidCount = 0;
  importState.skippedCount = 0;
  importState.startTime = performance.now();

  const previewRows = [];

  rows.forEach((row) => {
    const keys = Object.keys(row);
    const findValue = (possibleNames) => {
      const match = keys.find(k => possibleNames.includes(k.trim().toLowerCase()));
      return match ? String(row[match]).trim() : "";
    };

    const fullName = findValue(["full name", "fullname", "name"]);
    const email = findValue(["email", "e-mail"]);
    const phone = findValue(["phone", "phone number", "mobile", "tel"]);
    const role = findValue(["role", "role / position", "position", "designation"]);
    const dept = findValue(["department", "dept"]);
    const year = findValue(["year", "academic year"]);

    if (!fullName) {
      importState.skippedCount++;
      const isEmptyRow = !email && !phone && !role && !dept && !year;
      if (!isEmptyRow) {
        previewRows.push({
          name: "[Empty Name]",
          role: role,
          dept: dept,
          year: year,
          phone: phone,
          email: email,
          status: "Missing Name",
          isValid: false
        });
      }
      return;
    }

    let isValid = true;
    let statusText = "Ready";

    if (phone) {
      const isDigits = /^\d+$/.test(phone);
      if (!isDigits || phone.length !== 10) {
        isValid = false;
        statusText = "Invalid Phone";
      }
    }

    if (email && isValid) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        isValid = false;
        statusText = "Invalid Email";
      }
    }

    const allowedYears = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
    if (year && isValid) {
      if (!allowedYears.includes(year)) {
        isValid = false;
        statusText = "Invalid Year";
      }
    }

    if (isValid) {
      const nameDup = APP.members.some(m => m.name && m.name.toLowerCase() === fullName.toLowerCase());
      const emailDup = email && APP.members.some(m => m.email && m.email.toLowerCase() === email.toLowerCase());

      if (nameDup || emailDup) {
        statusText = "Already Exists";
        importState.duplicateCount++;
      } else {
        importState.validMembers.push({
          name: fullName,
          email: email,
          phone: phone,
          role: role,
          department: dept,
          year: year
        });
      }
    } else {
      importState.invalidCount++;
    }

    if (previewRows.length < 100) {
      previewRows.push({
        name: fullName,
        role: role,
        dept: dept,
        year: year,
        phone: phone,
        email: email,
        status: statusText,
        isValid: isValid && statusText === "Ready"
      });
    }
  });

  $('#import-stat-total').textContent = rows.length;
  $('#import-stat-valid').textContent = importState.validMembers.length;
  $('#import-stat-dup').textContent = importState.duplicateCount;
  $('#import-stat-invalid').textContent = importState.invalidCount;
  $('#import-stat-skipped').textContent = importState.skippedCount;

  const tbody = $('#import-preview-table-body');
  if (previewRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 20px;">No rows found in Excel sheet.</td></tr>`;
  } else {
    tbody.innerHTML = previewRows.map(r => {
      let statusColor = "var(--success)";
      if (r.status === "Already Exists") statusColor = "var(--warning)";
      else if (r.status.startsWith("Invalid") || r.status.startsWith("Missing")) statusColor = "var(--danger)";

      return `
        <tr>
          <td style="padding: 8px;">${escapeHtml(r.name)}</td>
          <td style="padding: 8px;">${escapeHtml(r.role || "—")}</td>
          <td style="padding: 8px;">${escapeHtml(r.dept || "—")}</td>
          <td style="padding: 8px;">${escapeHtml(r.year || "—")}</td>
          <td style="padding: 8px;">${escapeHtml(r.phone || "—")}</td>
          <td style="padding: 8px;">${escapeHtml(r.email || "—")}</td>
          <td style="padding: 8px; text-align: right; font-weight: 600; color: ${statusColor};">${escapeHtml(r.status)}</td>
        </tr>
      `;
    }).join('');
  }

  $('#confirm-import-btn').disabled = importState.validMembers.length === 0;
  $('#import-preview-view').classList.remove('hidden');
  $('#import-result-view').classList.add('hidden');
  $('#import-modal-footer').classList.remove('hidden');
  $('#import-progress-container').classList.add('hidden');
  $('#import-progress-bar').style.width = '0%';
  $('#import-progress-percent').textContent = '0%';

  showModal('import-preview-modal');
}

async function commitImport() {
  if (importState.validMembers.length === 0) return;

  const validList = importState.validMembers;
  const targetCategory = importState.targetCategory;

  $('#confirm-import-btn').disabled = true;
  $('#import-progress-container').classList.remove('hidden');

  const creator = auth.currentUser ? auth.currentUser.email : "system";
  const now = firebase.firestore.FieldValue.serverTimestamp();

  const BATCH_LIMIT = 500;
  let totalBatches = Math.ceil(validList.length / BATCH_LIMIT);
  let batchesCommitted = 0;

  try {
    for (let i = 0; i < validList.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      const chunk = validList.slice(i, i + BATCH_LIMIT);

      chunk.forEach(m => {
        const docRef = db.collection('members').doc();
        const memberData = {
          name: m.name,
          category: targetCategory,
          role: m.role || "",
          department: m.department || "",
          year: m.year || "",
          phone: m.phone || "",
          email: m.email || "",
          createdAt: now,
          updatedAt: now,
          createdBy: creator,
          isActive: true,
          searchName: m.name.toLowerCase()
        };
        batch.set(docRef, memberData);
      });

      await batch.commit();
      batchesCommitted++;

      const percent = Math.round((batchesCommitted / totalBatches) * 100);
      $('#import-progress-bar').style.width = `${percent}%`;
      $('#import-progress-percent').textContent = `${percent}%`;
    }

    const timeTaken = ((performance.now() - importState.startTime) / 1000).toFixed(2);

    // Refresh members and all views
    await fetchMembers();
    renderDashboard();
    renderAttendanceLists();
    renderMembersList();
    updateSettingsCounts();

    // Show results inside the preview modal
    $('#import-preview-view').classList.add('hidden');
    $('#import-modal-footer').classList.add('hidden');
    $('#import-result-view').classList.remove('hidden');
    $('#import-result-text').innerHTML = `
      <strong>Successfully Imported:</strong> ${validList.length}<br>
      <strong>Duplicates Skipped:</strong> ${importState.duplicateCount}<br>
      <strong>Invalid Rows Skipped:</strong> ${importState.invalidCount}<br>
      <strong>Time Taken:</strong> ${timeTaken} seconds
    `;

    showToast(`Successfully imported ${validList.length} members`, "success");
  } catch (err) {
    console.error("Firestore batch commit failed:", err);
    showToast("Import failed: " + err.message, "error");
    $('#confirm-import-btn').disabled = false;
    $('#import-progress-container').classList.add('hidden');
  }
}

function downloadTemplate(categoryPreset) {
  try {
    const headers = [
      ["Full Name", "Category", "Role / Position", "Department", "Year", "Phone", "Email"],
      ["John Doe", categoryPreset || "Board Official", "President", "ECE", "4th Year", "9876543210", "john.doe@example.com"]
    ];

    const ws = XLSX.utils.aoa_to_sheet(headers);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Member Template");

    const filename = `${(categoryPreset || "Member").replace(/\s+/g, "_")}_Template.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast("Template downloaded successfully", "success");
  } catch (err) {
    console.error("Template generation failed:", err);
    showToast("Failed to download template: " + err.message, "error");
  }
}

// Members & Attendance search & filter event listeners
document.addEventListener('DOMContentLoaded', () => {
  const searchEl = $('#member-search');
  const filterEl = $('#member-category-filter');
  if (searchEl) searchEl.addEventListener('input', debounce(renderMembersList, 250));
  if (filterEl) filterEl.addEventListener('change', renderMembersList);

  const searchAttEl = $('#attendance-search');
  if (searchAttEl) searchAttEl.addEventListener('input', debounce(renderAttendanceLists, 250));
});

// ============================================================
// ATTENDANCE MODULE
// ============================================================

function getAttendanceMembers() {
  let baseMembers = [...APP.members];

  if (APP.editingSessionId) {
    const session = APP.sessions.find(s => s.id === APP.editingSessionId);
    if (session) {
      const merged = [];
      const seenIds = new Set();

      // First, add all records from the saved session
      (session.records || []).forEach(r => {
        merged.push({
          id: r.memberId,
          name: r.memberName,
          category: r.category,
          role: r.role || ''
        });
        seenIds.add(r.memberId);
      });

      // Then, add any current member from APP.members who isn't in the saved session records
      APP.members.forEach(m => {
        if (!seenIds.has(m.id)) {
          merged.push(m);
        }
      });

      baseMembers = merged;
    }
  }

  // Filter out any members that have been removed during this session edit
  if (APP.removedMemberIds) {
    baseMembers = baseMembers.filter(m => !APP.removedMemberIds.has(m.id));
  }

  return baseMembers;
}

function removeMemberFromSession(memberId) {
  let name = 'Member';
  const member = APP.members.find(m => m.id === memberId);
  if (member) {
    name = member.name;
  } else if (APP.editingSessionId) {
    const session = APP.sessions.find(s => s.id === APP.editingSessionId);
    const rec = session?.records?.find(r => r.memberId === memberId);
    if (rec) name = rec.memberName;
  }

  showConfirm(
    'Remove Member',
    `Are you sure you want to remove "${name}" from this attendance session?`,
    () => {
      APP.removedMemberIds.add(memberId);
      if (APP.attendance[memberId]) {
        delete APP.attendance[memberId];
      }
      renderAttendanceLists();
      showToast(`"${name}" removed from this session.`, 'info');
    }
  );
}

function renderAttendanceLists() {
  const searchQuery = ($('#attendance-search')?.value || '').toLowerCase();

  const renderSection = (category, containerSel, countSel, sectionSel) => {
    const section = $(sectionSel);
    if (!section) return 0;

    let members = getAttendanceMembers().filter(m => m.category === category);

    if (searchQuery) {
      members = members.filter(m =>
        (m.name || '').toLowerCase().includes(searchQuery) ||
        (m.role || '').toLowerCase().includes(searchQuery) ||
        (m.department || '').toLowerCase().includes(searchQuery)
      );
    }

    // Render count badge
    const countEl = $(countSel);
    if (countEl) countEl.textContent = members.length;

    // Show/hide section based on search count
    if (searchQuery && members.length === 0) {
      section.classList.add('hidden');
    } else {
      section.classList.remove('hidden');
    }

    // Render list items
    const container = $(containerSel);
    if (!container) return members.length;

    if (members.length === 0) {
      const displayCategory = category === 'Rotaractor' ? 'Green Rotaractor' : (category === 'Other Rotaractor' ? 'Rotaractor' : category);
      container.innerHTML = `
        <div class="empty-state" style="padding:24px;">
          <p style="color:var(--text-tertiary); font-size:0.85rem;">No ${displayCategory.toLowerCase()}s found</p>
        </div>`;
      return 0;
    }

    container.innerHTML = members.map(m => {
      const att = APP.attendance[m.id] || {};
      const presentActive = att.status === 'Present' ? 'present-active' : '';
      const absentActive = att.status === 'Absent' ? 'absent-active' : '';
      const lateActive = att.status === 'Late' ? 'late-active' : '';
      const markedClass = att.status ? `marked-${att.status.toLowerCase()}` : '';
      const showReason = att.status === 'Absent';

      return `
        <div class="attendance-item ${markedClass}" id="att-item-${m.id}">
          <div class="attendance-member-info">
            <div class="attendance-member-name">${escapeHtml(m.name)}</div>
            <div class="attendance-member-role">${escapeHtml(m.role || 'Member')}</div>
          </div>
          <div class="attendance-status-btns">
            <button class="status-btn ${presentActive}" onclick="markAttendance('${m.id}', 'Present')" title="Present">
              <i class="fas fa-check"></i> P
            </button>
            <button class="status-btn ${absentActive}" onclick="markAttendance('${m.id}', 'Absent')" title="Absent">
              <i class="fas fa-times"></i> A
            </button>
            <button class="status-btn ${lateActive}" onclick="markAttendance('${m.id}', 'Late')" title="Late">
              <i class="fas fa-clock"></i> L
            </button>
            <button class="status-btn" onclick="removeMemberFromSession('${m.id}')" title="Remove Member" style="color:var(--danger); border-color:transparent; background:transparent; padding:6px 8px; min-width:unset;">
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </div>
        ${showReason ? `
          <div class="attendance-reason" id="reason-${m.id}">
            <input type="text" placeholder="Reason for absence (optional)" value="${escapeHtml(att.reason || '')}" onchange="updateReason('${m.id}', this.value)" style="max-width:100%;">
          </div>` : ''}
      `;
    }).join('');

    return members.length;
  };

  const boardCount = renderSection('Board Official', '#board-officials-list', '#board-count-badge', '#board-officials-section');
  const rotaractorCount = renderSection('Rotaractor', '#rotaractors-list', '#rotaractor-count-badge', '#rotaractors-section');
  const otherCount = renderSection('Other Rotaractor', '#other-rotaractors-list', '#other-count-badge', '#other-rotaractors-section');

  updateAttendanceCounts();

  // Handle empty search results state
  const totalMatches = boardCount + rotaractorCount + otherCount;
  const emptyStateEl = $('#attendance-empty-state');
  if (searchQuery && totalMatches === 0) {
    if (!emptyStateEl) {
      const el = document.createElement('div');
      el.id = 'attendance-empty-state';
      el.className = 'empty-state';
      el.innerHTML = `
        <div class="empty-state-icon"><i class="fas fa-users-slash"></i></div>
        <h3>No matching members found</h3>
        <p>Try searching for another name or role</p>
      `;
      const saveBar = $('#attendance-save-bar');
      if (saveBar) {
        $('#attendance-tab').insertBefore(el, saveBar);
      } else {
        $('#attendance-tab').appendChild(el);
      }
    } else {
      emptyStateEl.classList.remove('hidden');
    }
  } else {
    if (emptyStateEl) emptyStateEl.classList.add('hidden');
  }
}

function markAttendance(memberId, status) {
  if (!APP.attendance[memberId]) {
    APP.attendance[memberId] = {};
  }

  // Toggle: if already set to same status, unmark
  if (APP.attendance[memberId].status === status) {
    delete APP.attendance[memberId].status;
    delete APP.attendance[memberId].reason;
  } else {
    APP.attendance[memberId].status = status;
    if (status !== 'Absent') {
      delete APP.attendance[memberId].reason;
    }
  }

  renderAttendanceLists();
}

function updateReason(memberId, reason) {
  if (APP.attendance[memberId]) {
    APP.attendance[memberId].reason = reason;
  }
}

function markAllStatus(category, status) {
  const members = getAttendanceMembers().filter(m => m.category === category);
  members.forEach(m => {
    if (!APP.attendance[m.id]) APP.attendance[m.id] = {};
    APP.attendance[m.id].status = status;
    if (status !== 'Absent') delete APP.attendance[m.id].reason;
  });
  renderAttendanceLists();
  showToast(`All ${category}s marked as ${status}.`, 'info');
}

function clearCategoryAttendance(category) {
  const members = getAttendanceMembers().filter(m => m.category === category);
  members.forEach(m => {
    delete APP.attendance[m.id];
  });
  renderAttendanceLists();
  showToast(`${category} attendance cleared.`, 'info');
}

function clearAllAttendance() {
  showConfirm('Clear All Attendance?', 'This will reset all attendance marks for this session.', () => {
    APP.attendance = {};
    if (APP.editingSessionId) {
      APP.editingSessionId = null;
      APP.removedMemberIds = new Set();
      // Clear form inputs
      $('#event-name').value = '';
      if ($('#attendance-service')) $('#attendance-service').value = '';
      if ($('#attendance-service-custom')) $('#attendance-service-custom').value = '';
      if ($('#custom-service-wrapper')) $('#custom-service-wrapper').classList.add('hidden');
      if ($('#attendance-venue')) $('#attendance-venue').value = '';
      setDefaultDate();

      const heading = $('#attendance-tab h1');
      if (heading) heading.textContent = 'Take Attendance';
      const saveBtn = $('#save-attendance-btn');
      if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Attendance';
    }
    renderAttendanceLists();
    showToast('All attendance cleared.', 'info');
  });
}

function updateAttendanceCounts() {
  let present = 0, absent = 0, late = 0, unmarked = 0;
  const membersList = getAttendanceMembers();
  membersList.forEach(m => {
    const att = APP.attendance[m.id];
    if (!att || !att.status) unmarked++;
    else if (att.status === 'Present') present++;
    else if (att.status === 'Absent') absent++;
    else if (att.status === 'Late') late++;
  });

  const pEl = $('#att-present-count');
  const aEl = $('#att-absent-count');
  const lEl = $('#att-late-count');
  const uEl = $('#att-unmarked-count');
  if (pEl) pEl.textContent = present;
  if (aEl) aEl.textContent = absent;
  if (lEl) lEl.textContent = late;
  if (uEl) uEl.textContent = unmarked;
}

// ---- Save Attendance Session ----
async function saveAttendance() {
  const date = $('#attendance-date').value;
  const eventTime = $('#attendance-time')?.value || '';
  const eventName = $('#event-name').value.trim();
  const serviceSelect = $('#attendance-service');
  let serviceType = serviceSelect?.value || '';
  if (serviceType === 'Other') {
    serviceType = ($('#attendance-service-custom')?.value || '').trim();
  }
  const venue = ($('#attendance-venue')?.value || '').trim();

  // Validation
  if (!date) {
    showToast('Please select a date.', 'warning');
    $('#attendance-date').focus();
    return;
  }

  if (!eventTime) {
    showToast('Please select a time.', 'warning');
    $('#attendance-time').focus();
    return;
  }

  if (!eventName) {
    showToast('Please enter an event name.', 'warning');
    $('#event-name').focus();
    return;
  }

  if (!serviceType) {
    showToast('Please select a service / avenue.', 'warning');
    $('#attendance-service')?.focus();
    return;
  }

  if (!venue) {
    showToast('Please enter the event venue.', 'warning');
    $('#attendance-venue')?.focus();
    return;
  }

  if (APP.members.length === 0) {
    showToast('No members to take attendance for. Add members first.', 'warning');
    return;
  }

  // Check if all members are marked
  const unmarkedMembers = APP.members.filter(m => !APP.attendance[m.id] || !APP.attendance[m.id].status);
  if (unmarkedMembers.length > 0) {
    showConfirm(
      `${unmarkedMembers.length} member(s) unmarked`,
      'Unmarked members will be recorded as Absent. Continue?',
      () => doSaveAttendance(date, eventTime, eventName, serviceType, venue)
    );
    return;
  }

  await doSaveAttendance(date, eventTime, eventName, serviceType, venue);
}

async function doSaveAttendance(date, eventTime, eventName, serviceType, venue) {
  const btn = $('#save-attendance-btn');
  btn.disabled = true;
  btn.innerHTML = APP.editingSessionId
    ? '<i class="fas fa-spinner fa-spin"></i> Updating...'
    : '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    // Build records using getAttendanceMembers() to include/exclude members dynamically
    const records = getAttendanceMembers().map(m => {
      const att = APP.attendance[m.id] || {};
      return {
        memberId: m.id,
        memberName: m.name,
        category: m.category,
        role: m.role || '',
        status: att.status || 'Absent',
        reason: att.reason || '',
        remarks: att.remarks || ''
      };
    });

    const totalMembers = records.length;
    const totalPresent = records.filter(r => r.status === 'Present').length;
    const totalAbsent = records.filter(r => r.status === 'Absent').length;
    const totalLate = records.filter(r => r.status === 'Late').length;
    const attendanceRate = totalMembers > 0 ? Math.round(((totalPresent + totalLate) / totalMembers) * 100) : 0;

    const sessionData = {
      eventName,
      date,
      eventTime,
      serviceType: serviceType || '',
      venue: venue || '',
      totalMembers,
      totalPresent,
      totalAbsent,
      totalLate,
      attendanceRate,
      records
    };

    let sessionId;
    if (APP.editingSessionId) {
      sessionId = APP.editingSessionId;
      sessionData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      sessionData.updatedBy = auth.currentUser?.email || 'unknown';

      await db.collection('sessions').doc(sessionId).update(sessionData);
      showToast(`Attendance updated for "${eventName}".`, 'success');
    } else {
      sessionData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      sessionData.createdBy = auth.currentUser?.email || 'unknown';

      const docRef = await db.collection('sessions').add(sessionData);
      sessionId = docRef.id;
      showToast(`Attendance saved for "${eventName}".`, 'success');
    }

    // Refresh sessions first so that APP.sessions contains the saved/updated session
    await fetchSessions();

    // Trigger auto-upload to Google Drive on UPDATE only if enabled and authenticated
    if (APP.editingSessionId && APP.driveSettings && APP.driveSettings.driveConnected && APP.driveSettings.autoUpload) {
      uploadSessionPDFToDrive(sessionId).catch(err => {
        console.error('Auto-upload to Google Drive failed:', err);
      });
    }

    // Reset Edit Mode
    APP.editingSessionId = null;
    APP.removedMemberIds = new Set();

    // Reset headings and buttons
    const heading = $('#attendance-tab h1');
    if (heading) heading.textContent = 'Take Attendance';
    const saveBtn = $('#save-attendance-btn');
    if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Attendance';

    // Reset form fields
    APP.attendance = {};
    $('#event-name').value = '';
    if ($('#attendance-service')) $('#attendance-service').value = '';
    if ($('#attendance-service-custom')) $('#attendance-service-custom').value = '';
    if ($('#custom-service-wrapper')) $('#custom-service-wrapper').classList.add('hidden');
    if ($('#attendance-venue')) $('#attendance-venue').value = '';
    setDefaultDate();

    // Refresh UI components
    renderAttendanceLists();
    renderReportsList();
    renderDashboard();
    updateSettingsCounts();

    // Switch to reports
    switchTab('reports');

  } catch (err) {
    console.error('Error saving attendance:', err);
    showToast('Failed to save attendance. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = APP.editingSessionId
      ? '<i class="fas fa-save"></i> Update Attendance'
      : '<i class="fas fa-save"></i> Save Attendance';
  }
}

// ============================================================
// REPORTS MODULE
// ============================================================

function renderReportsList() {
  const container = $('#reports-list');
  const searchQuery = ($('#report-search')?.value || '').toLowerCase();
  const dateFilter = $('#report-date-filter')?.value || '';
  const statusFilter = $('#report-status-filter')?.value || 'all';

  let filtered = [...APP.sessions];

  if (searchQuery) {
    filtered = filtered.filter(s => (s.eventName || '').toLowerCase().includes(searchQuery));
  }

  if (dateFilter) {
    filtered = filtered.filter(s => s.date === dateFilter);
  }

  // Status filter applies to which sessions to show (sessions containing that status)
  if (statusFilter !== 'all') {
    filtered = filtered.filter(s =>
      s.records && s.records.some(r => r.status === statusFilter)
    );
  }

  // Update count
  const countEl = $('#report-session-count');
  if (countEl) animateCounter(countEl, filtered.length);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-clipboard-list"></i></div>
        <h3>No reports found</h3>
        <p>${searchQuery || dateFilter ? 'Try different filters' : 'Save an attendance session to see reports here'}</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(s => {
    const dateObj = s.date ? new Date(s.date + 'T00:00:00') : new Date();
    const day = dateObj.getDate();
    const month = dateObj.toLocaleString('en', { month: 'short' });
    const rate = s.attendanceRate || 0;
    const barClass = rate >= 75 ? 'high' : rate >= 50 ? 'medium' : 'low';

    return `
      <div class="report-card" onclick="showReportDetail('${s.id}')">
        <div class="report-date-badge">
          <span class="day">${day}</span>
          <span class="month">${month}</span>
        </div>
        <div class="report-info">
          <div class="report-event-name" style="display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
            ${escapeHtml(s.eventName || 'Untitled Event')}
            ${(() => {
        const status = s.uploadStatus || '';
        if (status === 'Synced') return `<span class="badge badge-sync-success" style="font-size:0.65rem; text-transform:none;"><i class="fas fa-check-circle" style="margin-right: 3px;"></i>Synced</span>`;
        if (status === 'Syncing') return `<span class="badge badge-syncing" style="font-size:0.65rem; text-transform:none;"><i class="fas fa-spinner fa-spin" style="margin-right: 3px;"></i>Syncing...</span>`;
        if (status === 'Failed') return `<span class="badge badge-sync-failed" style="font-size:0.65rem; text-transform:none;"><i class="fas fa-exclamation-triangle" style="margin-right: 3px;"></i>Sync Failed</span>`;
        return `<span class="badge badge-unsynced" style="font-size:0.65rem; text-transform:none;"><i class="fas fa-cloud" style="margin-right: 3px;"></i>Unsynced</span>`;
      })()}
          </div>
          <div class="report-meta">
            ${s.serviceType ? `<span><i class="fas fa-hands-helping"></i> ${escapeHtml(s.serviceType)}</span>` : ''}
            <span><i class="fas fa-calendar"></i> ${s.date || 'N/A'}</span>
            ${s.venue ? `<span><i class="fas fa-map-marker-alt"></i> ${escapeHtml(s.venue)}</span>` : ''}
            <span><i class="fas fa-users"></i> ${s.totalMembers || 0} members</span>
            <span><i class="fas fa-check"></i> ${s.totalPresent || 0} present</span>
            <span><i class="fas fa-percentage"></i> ${rate}%</span>
          </div>
        </div>
        <div class="report-attendance-bar">
          <div class="bar-fill ${barClass}" style="width:${rate}%;"></div>
        </div>
        <div class="report-actions" onclick="event.stopPropagation();">
          ${APP.userRole && APP.userRole.accessMode === 'admin' ? `
            <button class="btn-icon" onclick="startEditSession('${s.id}')" title="Edit"><i class="fas fa-pencil-alt"></i></button>
          ` : ''}
          <button class="btn-icon" onclick="exportSessionPDF('${s.id}')" title="Export PDF"><i class="fas fa-file-pdf"></i></button>
          <button class="btn-icon" onclick="exportSessionExcel('${s.id}')" title="Export Excel"><i class="fas fa-file-excel"></i></button>
          ${s.uploadStatus === 'Synced' && s.fileUrl ? `
            <a class="btn-icon" href="${s.fileUrl}" target="_blank" title="View in Google Drive" style="color:var(--success); display:inline-flex; align-items:center; justify-content:center;"><i class="fab fa-google-drive"></i></a>
          ` : ''}
          ${APP.userRole && APP.userRole.accessMode === 'admin' && s.uploadStatus === 'Synced' ? `
            <button class="btn-icon" onclick="uploadSessionPDFToDrive('${s.id}')" title="Re-upload to Google Drive" style="color:var(--accent);"><i class="fas fa-sync-alt"></i></button>
          ` : ''}
          ${APP.userRole && APP.userRole.accessMode === 'admin' && s.uploadStatus !== 'Synced' ? `
            <button class="btn-icon" onclick="uploadSessionPDFToDrive('${s.id}')" title="Upload to Google Drive" style="color:var(--primary);"><i class="fas fa-cloud-upload-alt"></i></button>
          ` : ''}
          ${APP.userRole && APP.userRole.accessMode === 'admin' && s.uploadStatus === 'Failed' ? `
            <button class="btn-icon" onclick="uploadSessionPDFToDrive('${s.id}')" title="Retry Upload" style="color:var(--danger);"><i class="fas fa-redo-alt"></i></button>
          ` : ''}
          ${APP.userRole && APP.userRole.accessMode === 'admin' ? `<button class="btn-icon danger" onclick="deleteSession('${s.id}')" title="Delete"><i class="fas fa-trash-alt"></i></button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function showReportDetail(sessionId) {
  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) return;

  APP.currentReportSession = session;

  $('#report-detail-title').textContent = session.eventName || 'Session Details';

  const records = session.records || [];
  const presentRecords = records
    .filter(r => r.status === 'Present')
    .sort((a, b) => (a.memberName || '').localeCompare(b.memberName || ''));

  const absentRecords = records
    .filter(r => r.status === 'Absent' || r.status === 'Late')
    .sort((a, b) => (a.memberName || '').localeCompare(b.memberName || ''));

  let html = `
    <div class="report-detail-header" style="text-align:left; padding-bottom:16px; border-bottom:1px solid var(--border); margin-bottom:16px;">
      ${session.serviceType ? `<p style="margin:4px 0; font-size:1.1rem; color:var(--accent); font-weight:700; text-transform:uppercase;"><i class="fas fa-hands-helping" style="margin-right:6px;"></i>${escapeHtml(session.serviceType)}</p>` : ''}
      <p style="margin:4px 0; font-size:1rem; color:var(--text-primary);"><strong>Project Name:</strong> ${escapeHtml(session.eventName)}</p>
      ${session.venue ? `<p style="margin:4px 0; font-size:1rem; color:var(--text-primary);"><strong>Venue:</strong> ${escapeHtml(session.venue)}</p>` : ''}
      <p style="margin:4px 0; font-size:1rem; color:var(--text-primary);"><strong>Date:</strong> ${session.date || 'N/A'}</p>
      <p style="margin:4px 0; font-size:1rem; color:var(--text-primary);"><strong>Time:</strong> ${formatTime12Hour(session.eventTime)}</p>
      <p style="margin:4px 0; font-size:1rem; color:var(--text-primary); display:flex; align-items:center; gap:8px;"><strong>Drive Sync:</strong> ${(() => {
      const status = session.uploadStatus || '';
      if (status === 'Synced') return `<span class="badge badge-sync-success" style="font-size:0.75rem; text-transform:none;"><i class="fas fa-check-circle" style="margin-right: 3px;"></i>Synced to Drive</span>`;
      if (status === 'Syncing') return `<span class="badge badge-syncing" style="font-size:0.75rem; text-transform:none;"><i class="fas fa-spinner fa-spin" style="margin-right: 3px;"></i>Syncing...</span>`;
      if (status === 'Failed') return `<span class="badge badge-sync-failed" style="font-size:0.75rem; text-transform:none;"><i class="fas fa-exclamation-triangle" style="margin-right: 3px;"></i>Sync Failed</span>`;
      return `<span class="badge badge-unsynced" style="font-size:0.75rem; text-transform:none;"><i class="fas fa-cloud" style="margin-right: 3px;"></i>Not Synced</span>`;
    })()}</p>
    </div>

    <div class="report-summary-cards" style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom: 20px;">
      <div class="report-summary-card" style="text-align:left; padding:16px; background:var(--bg-secondary); border-radius:var(--radius-md);">
        <span class="label" style="font-size:0.8rem; text-transform:uppercase; color:var(--text-secondary); font-weight:600; display:block;">Total Attendees</span>
        <span class="value" style="font-size:2rem; font-weight:800; color:var(--success);">${session.totalPresent || 0}</span>
      </div>
      <div class="report-summary-card" style="text-align:left; padding:16px; background:var(--bg-secondary); border-radius:var(--radius-md);">
        <span class="label" style="font-size:0.8rem; text-transform:uppercase; color:var(--text-secondary); font-weight:600; display:block;">Total Absentees</span>
        <span class="value" style="font-size:2rem; font-weight:800; color:var(--danger);">${session.totalAbsent || 0}</span>
      </div>
    </div>

    <!-- Inner modal tabs -->
    <div class="modal-tab-bar" style="display:flex; border-bottom:1px solid var(--border); margin-bottom:16px; gap:16px;">
      <button class="modal-tab-btn active" id="modal-tab-attendees" style="background:none; border:none; padding:10px 0; font-weight:600; color:var(--accent); border-bottom:2px solid var(--accent); cursor:pointer;">
        Attendees (${presentRecords.length})
      </button>
      <button class="modal-tab-btn" id="modal-tab-absentees" style="background:none; border:none; padding:10px 0; font-weight:600; color:var(--text-secondary); cursor:pointer;">
        Absentees/Late (${absentRecords.length})
      </button>
    </div>

    <!-- Attendees list section -->
    <div id="modal-sec-attendees" class="modal-section-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 50px;">#</th>
              <th>Name</th>
              <th style="width: 100px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${presentRecords.length > 0 ? presentRecords.map((r, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(r.memberName)}</td>
                <td><span class="badge badge-present">Present</span></td>
              </tr>`).join('') : '<tr><td colspan="3" class="text-center" style="padding:20px;">No attendees were present.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Absentees list section -->
    <div id="modal-sec-absentees" class="modal-section-content hidden">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 50px;">#</th>
              <th>Name</th>
              <th style="width: 100px;">Status</th>
              <th>Reason for Absence</th>
            </tr>
          </thead>
          <tbody>
            ${absentRecords.length > 0 ? absentRecords.map((r, i) => {
      const badgeClass = r.status === 'Absent' ? 'badge-absent' : 'badge-late';
      return `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(r.memberName)}</td>
                <td><span class="badge ${badgeClass}">${r.status}</span></td>
                <td style="color:var(--text-primary); font-style:italic;">${escapeHtml(r.reason || 'No reason provided')}</td>
              </tr>`;
    }).join('') : '<tr><td colspan="4" class="text-center" style="padding:20px;">No absentees or late members.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  $('#report-detail-body').innerHTML = html;

  // Add click handlers for the modal tabs
  const tabAttendees = $('#modal-tab-attendees');
  const tabAbsentees = $('#modal-tab-absentees');
  const secAttendees = $('#modal-sec-attendees');
  const secAbsentees = $('#modal-sec-absentees');

  if (tabAttendees && tabAbsentees && secAttendees && secAbsentees) {
    tabAttendees.onclick = () => {
      tabAttendees.classList.add('active');
      tabAttendees.style.color = 'var(--accent)';
      tabAttendees.style.borderBottom = '2px solid var(--accent)';

      tabAbsentees.classList.remove('active');
      tabAbsentees.style.color = 'var(--text-secondary)';
      tabAbsentees.style.borderBottom = 'none';

      secAttendees.classList.remove('hidden');
      secAbsentees.classList.add('hidden');
    };

    tabAbsentees.onclick = () => {
      tabAbsentees.classList.add('active');
      tabAbsentees.style.color = 'var(--accent)';
      tabAbsentees.style.borderBottom = '2px solid var(--accent)';

      tabAttendees.classList.remove('active');
      tabAttendees.style.color = 'var(--text-secondary)';
      tabAttendees.style.borderBottom = 'none';

      secAbsentees.classList.remove('hidden');
      secAttendees.classList.add('hidden');
    };
  }

  // Wire export buttons
  $('#detail-export-pdf-btn').onclick = () => exportSessionPDF(sessionId);
  $('#detail-export-excel-btn').onclick = () => exportSessionExcel(sessionId);

  showModal('report-detail-modal');
}

function startEditSession(sessionId) {
  if (!APP.userRole || APP.userRole.accessMode !== 'admin') {
    showToast('Permission Denied: Only Admins can edit sessions.', 'error');
    return;
  }

  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) {
    showToast('Session not found.', 'error');
    return;
  }

  APP.editingSessionId = sessionId;
  APP.removedMemberIds = new Set();

  // Populate Event details
  $('#event-name').value = session.eventName || '';
  $('#attendance-date').value = session.date || '';
  $('#attendance-time').value = session.eventTime || '';
  $('#attendance-venue').value = session.venue || '';

  const serviceSelect = $('#attendance-service');
  if (serviceSelect) {
    const knownAvenues = ['Club Service', 'Professional Service', 'International Service', 'Community Service', 'Blood Donation', 'Empowerment'];
    if (knownAvenues.includes(session.serviceType)) {
      serviceSelect.value = session.serviceType;
      $('#custom-service-wrapper')?.classList.add('hidden');
      if ($('#attendance-service-custom')) $('#attendance-service-custom').value = '';
    } else {
      serviceSelect.value = 'Other';
      $('#custom-service-wrapper')?.classList.remove('hidden');
      if ($('#attendance-service-custom')) $('#attendance-service-custom').value = session.serviceType || '';
    }
  }

  // Load saved attendance statuses
  APP.attendance = {};
  (session.records || []).forEach(r => {
    APP.attendance[r.memberId] = {
      status: r.status,
      reason: r.reason || '',
      remarks: r.remarks || ''
    };
  });

  // Update header title and save button text
  const heading = $('#attendance-tab h1');
  if (heading) heading.textContent = 'Edit Attendance';
  const saveBtn = $('#save-attendance-btn');
  if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Update Attendance';

  // Render lists and counts
  renderAttendanceLists();

  // Switch to the Attendance tab
  switchTab('attendance');
}

function deleteSession(sessionId) {
  if (!APP.userRole || APP.userRole.accessMode !== 'admin') {
    showToast('Permission Denied: Only Admins can delete sessions.', 'error');
    return;
  }
  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) return;

  showConfirm(
    `Delete "${session.eventName}"?`,
    'This will permanently remove this attendance session and all its records.',
    async () => {
      try {
        await db.collection('sessions').doc(sessionId).delete();
        showToast(`Session "${session.eventName}" deleted.`, 'success');
        await fetchSessions();
        renderReportsList();
        renderDashboard();
        updateSettingsCounts();
      } catch (err) {
        console.error('Error deleting session:', err);
        showToast('Failed to delete session.', 'error');
      }
    },
    'danger'
  );
}

function clearReportFilters() {
  const search = $('#report-search');
  const dateFilter = $('#report-date-filter');
  const statusFilter = $('#report-status-filter');
  if (search) search.value = '';
  if (dateFilter) dateFilter.value = '';
  if (statusFilter) statusFilter.value = 'all';
  renderReportsList();
}

// Reports search & filter event listeners
document.addEventListener('DOMContentLoaded', () => {
  const searchEl = $('#report-search');
  const dateEl = $('#report-date-filter');
  const statusEl = $('#report-status-filter');
  if (searchEl) searchEl.addEventListener('input', debounce(renderReportsList, 250));
  if (dateEl) dateEl.addEventListener('change', renderReportsList);
  if (statusEl) statusEl.addEventListener('change', renderReportsList);
});

// ============================================================
// DASHBOARD MODULE
// ============================================================

function renderDashboard() {
  // Stats
  const totalMembers = APP.members.length;
  const totalSessions = APP.sessions.length;
  const avgAttendance = totalSessions > 0
    ? Math.round(APP.sessions.reduce((sum, s) => sum + (s.attendanceRate || 0), 0) / totalSessions)
    : 0;

  const lastSession = APP.sessions.length > 0 ? APP.sessions[0] : null;
  const presentToday = lastSession ? `${lastSession.totalPresent || 0}/${lastSession.totalMembers || 0}` : '—';

  animateCounter($('#dash-total-members'), totalMembers);
  animateCounter($('#dash-total-sessions'), totalSessions);
  animateCounter($('#dash-avg-attendance'), avgAttendance, '%');
  animateCounter($('#dash-present-today'), presentToday);

  // Recent Sessions
  renderRecentSessions();

  // Category Breakdown
  renderCategoryBreakdown();

  // Leaderboard
  renderLeaderboard();
}

function renderRecentSessions() {
  const container = $('#recent-sessions-list');
  const recent = APP.sessions.slice(0, 5);

  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:24px 0;">
        <div class="empty-state-icon"><i class="fas fa-calendar-times"></i></div>
        <h3>No sessions yet</h3>
        <p>Take your first attendance to see sessions here</p>
      </div>`;
    return;
  }

  container.innerHTML = recent.map(s => {
    const rate = s.attendanceRate || 0;
    const rateColor = rate >= 75 ? 'var(--success)' : rate >= 50 ? 'var(--warning)' : 'var(--danger)';
    return `
      <div class="recent-session-item" style="cursor:pointer;" onclick="switchTab('reports')">
        <div class="recent-session-dot" style="background:${rateColor};"></div>
        <div class="recent-session-info">
          <div class="recent-session-name">${escapeHtml(s.eventName || 'Untitled')}</div>
          <div class="recent-session-date">${s.date || 'N/A'} · ${s.totalPresent || 0}/${s.totalMembers || 0} present</div>
        </div>
        <div class="recent-session-rate" style="color:${rateColor};">${rate}%</div>
      </div>`;
  }).join('');
}

function renderCategoryBreakdown() {
  const container = $('#category-chart');
  const boardCount = APP.members.filter(m => m.category === 'Board Official').length;
  const rotaractorCount = APP.members.filter(m => m.category === 'Rotaractor').length;
  const otherCount = APP.members.filter(m => m.category === 'Other Rotaractor').length;
  const total = APP.members.length || 1;

  container.innerHTML = `
    <div class="category-bar-item">
      <span class="category-bar-label">Board Officials</span>
      <div class="category-bar-track">
        <div class="category-bar-fill red" style="width:${(boardCount / total) * 100}%;"></div>
      </div>
      <span class="category-bar-count" id="dash-breakdown-board">0</span>
    </div>
    <div class="category-bar-item">
      <span class="category-bar-label">Green Rotaractors</span>
      <div class="category-bar-track">
        <div class="category-bar-fill green" style="width:${(rotaractorCount / total) * 100}%;"></div>
      </div>
      <span class="category-bar-count" id="dash-breakdown-rotaractor">0</span>
    </div>
    <div class="category-bar-item">
      <span class="category-bar-label">Rotaractors</span>
      <div class="category-bar-track">
        <div class="category-bar-fill blue" style="width:${(otherCount / total) * 100}%;"></div>
      </div>
      <span class="category-bar-count" id="dash-breakdown-other">0</span>
    </div>
  `;

  animateCounter($('#dash-breakdown-board'), boardCount);
  animateCounter($('#dash-breakdown-rotaractor'), rotaractorCount);
  animateCounter($('#dash-breakdown-other'), otherCount);
}

function renderLeaderboard() {
  const container = $('#dashboard-leaderboard-list');
  if (!container) return;

  try {
    const totalSessions = APP.sessions.length;
    const validMembers = APP.members.filter(m => m && m.id && m.name);

    if (totalSessions === 0 || validMembers.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:24px 0;">
          <div class="empty-state-icon"><i class="fas fa-trophy"></i></div>
          <h3>No records yet</h3>
          <p>Save attendance to see active members leaderboard</p>
        </div>`;
      return;
    }

    // Calculate attendance rate for each member
    const membersStats = validMembers.map(member => {
      const presentCount = APP.sessions.filter(s => {
        if (!s) return false;
        const records = Array.isArray(s.records) ? s.records : [];
        const rec = records.find(r => r && r.memberId === member.id);
        return rec && (rec.status === 'Present' || rec.status === 'Late');
      }).length;

      const percentage = Math.round((presentCount / totalSessions) * 100);
      return {
        name: String(member.name || ''),
        role: String(member.role || 'Member'),
        percentage: percentage
      };
    });

    // Sort by percentage desc, then alphabetically by name
    membersStats.sort((a, b) => {
      if (b.percentage !== a.percentage) {
        return b.percentage - a.percentage;
      }
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameA.localeCompare(nameB);
    });

    // Take top 5
    const top5 = membersStats.slice(0, 5);

    container.innerHTML = top5.map((m, idx) => {
      const rank = idx + 1;
      let rankClass = 'normal-rank';
      if (rank === 1) rankClass = 'top-1';
      else if (rank === 2) rankClass = 'top-2';
      else if (rank === 3) rankClass = 'top-3';

      return `
        <div class="leaderboard-row">
          <div class="leaderboard-rank ${rankClass}">${rank}</div>
          <div class="leaderboard-info">
            <div class="leaderboard-name">${escapeHtml(m.name)}</div>
            <div class="leaderboard-role">${escapeHtml(m.role)}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error rendering leaderboard:', err);
    container.innerHTML = `
      <div class="empty-state" style="padding:24px 0;">
        <div class="empty-state-icon" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i></div>
        <h3>Failed to load leaderboard</h3>
        <p>A database discrepancy was encountered.</p>
      </div>`;
  }
}

// ============================================================
// PDF EXPORT
// ============================================================

function exportSessionPDF(sessionId, download = true) {
  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) {
    showToast('Session not found.', 'error');
    return;
  }

  // ---- 1. VALIDATION ----
  const eventName = (session.eventName || '').trim();
  const venue = (session.venue || '').trim();
  const date = (session.date || '').trim();
  const time = (session.eventTime || '').trim();

  const attendees = (session.records || [])
    .filter(r => r.status === 'Present' || r.status === 'Late')
    .sort((a, b) => (a.memberName || '').localeCompare(b.memberName || ''));

  if (!eventName) {
    showToast('PDF Generation Failed: Event Name is missing.', 'error');
    return;
  }
  if (!venue) {
    showToast('PDF Generation Failed: Venue is missing.', 'error');
    return;
  }
  if (!date) {
    showToast('PDF Generation Failed: Date is missing.', 'error');
    return;
  }
  if (!time) {
    showToast('PDF Generation Failed: Time is missing.', 'error');
    return;
  }
  if (attendees.length === 0) {
    showToast('PDF Generation Failed: Attendance list is empty (no members marked Present or Late).', 'error');
    return;
  }

  try {
    const jsPDFClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFClass) {
      showToast('PDF library not loaded. Check your internet connection and refresh.', 'error');
      return;
    }
    const doc = new jsPDFClass({ unit: 'mm', format: 'a4' });
    const pageW = 210;
    const pageH = 297;
    const margin = 14;

    // ---- Helper: format date as DD/MM/YYYY ----
    function formatDateDMY(dateStr) {
      if (!dateStr) return 'N/A';
      const parts = dateStr.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
      return dateStr;
    }

    // ---- Helper: format time range style ----
    function formatTimeRange(timeStr) {
      if (!timeStr) return 'N/A';
      return formatTime12Hour(timeStr);
    }

    // ---- Setup branding & report title ----
    const bgLogo = $('#pdf-bg-logo') || $('.nav-brand-icon img');
    const reportTitle = (session.serviceType || 'Attendance Report').toUpperCase();

    // ---- Reusable template drawer for multi-page support ----
    function drawPageTemplate() {
      // A. Center Watermark Logo (Render at professional 16% opacity for optimal text overlay contrast)
      if (bgLogo) {
        try {
          const watermarkSize = 110;
          const wx = (pageW - watermarkSize) / 2;
          const wy = (pageH - watermarkSize) / 2 + 10;
          const gState = new (doc.GState || (window.jspdf && window.jspdf.GState))({ opacity: 0.16 });
          doc.saveGraphicsState();
          doc.setGState(gState);
          doc.addImage(bgLogo, 'PNG', wx, wy, watermarkSize, watermarkSize);
          doc.restoreGraphicsState();
        } catch (e) {
          console.warn('Watermark decoration failed:', e);
        }
      }

      // B. Double Page Borders
      // Outer Charcoal Border
      doc.setDrawColor(17, 17, 17);
      doc.setLineWidth(0.4);
      doc.rect(8, 8, pageW - 16, pageH - 16);

      // Inner Gold Accent Border
      doc.setDrawColor(212, 175, 55);
      doc.setLineWidth(0.2);
      doc.rect(9.5, 9.5, pageW - 19, pageH - 19);

      // C. Header Logo
      if (bgLogo) {
        try {
          doc.addImage(bgLogo, 'PNG', (pageW - 14) / 2, 13, 14, 14);
        } catch (e) {
          console.warn('Header logo failed:', e);
        }
      }

      // D. Header Typography (Using formal Times Roman)
      let headY = 32;
      doc.setFont('times', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(80, 80, 80);
      doc.text('ROTARACT CLUB OF', pageW / 2, headY, { align: 'center' });

      headY += 5;
      doc.setFont('times', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(17, 17, 17);
      doc.text('PRINCE SHRI VENKATESHWARA PADMAVATHY ENGINEERING COLLEGE', pageW / 2, headY, { align: 'center' });

      headY += 4.5;
      doc.setFont('times', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text('Sponsored by RC Chennai Velachery', pageW / 2, headY, { align: 'center' });

      headY += 4;
      doc.setFont('times', 'normal');
      doc.text('RI District 3233', pageW / 2, headY, { align: 'center' });

      // Gold Divider Line
      headY += 4;
      doc.setDrawColor(212, 175, 55);
      doc.setLineWidth(0.3);
      doc.line(14, headY, pageW - 14, headY);

      // E. Centered Category Title
      headY += 8;
      doc.setFont('times', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(17, 17, 17);
      doc.text(reportTitle, pageW / 2, headY, { align: 'center' });

      // Title Underline
      headY += 1.5;
      const titleW = doc.getTextWidth(reportTitle);
      doc.setDrawColor(17, 17, 17);
      doc.setLineWidth(0.3);
      doc.line((pageW - titleW) / 2, headY, (pageW + titleW) / 2, headY);

      return headY + 8;
    }

    // ==========================================
    // DRAW PAGE 1 METADATA
    // ==========================================
    let currentY = drawPageTemplate();

    // Event Info fields list
    const infoFields = [
      { label: 'Project Name :', val: eventName },
      { label: 'Venue :', val: venue },
      { label: 'Date :', val: formatDateDMY(date) },
      { label: 'Time :', val: formatTimeRange(time) },
      { label: 'Total Attendees :', val: String(attendees.length) }
    ];

    doc.setFontSize(10.5);
    infoFields.forEach(field => {
      doc.setFont('times', 'bold');
      doc.setTextColor(17, 17, 17);
      doc.text(field.label, 20, currentY);

      doc.setFont('times', 'normal');
      doc.text(field.val, 60, currentY);
      currentY += 6.5;
    });

    currentY += 4; // Add comfort spacing before list

    // ==========================================
    // DRAW ATTENDANCE MEMBER LIST (No Table)
    // ==========================================
    doc.setFontSize(11);
    doc.setFont('times', 'normal');
    doc.setTextColor(17, 17, 17);

    attendees.forEach((r, idx) => {
      const num = idx + 1;
      let prefix = 'Rtr. ';
      if (r.role) {
        const roleLower = r.role.toLowerCase();
        if (roleLower.includes('ipp')) prefix = 'Rtr. IPP. ';
      }
      const line = `${num}.   ${prefix}${(r.memberName || '').toUpperCase()}`;

      // Page overflow check (A4 boundary buffer)
      if (currentY > pageH - 20) {
        doc.addPage();
        currentY = drawPageTemplate();
        doc.setFontSize(11);
        doc.setFont('times', 'normal');
        doc.setTextColor(17, 17, 17);
      }

      doc.text(line, 20, currentY);
      currentY += 7; // Spacious and easy to read
    });

    // ==========================================
    // DYNAMIC PAGE NUMBER FOOTERS (Multi-page only)
    // ==========================================
    const totalPages = doc.internal.getNumberOfPages();
    if (totalPages > 1) {
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont('times', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(120, 120, 120);
        doc.text(`Page ${p} of ${totalPages}`, pageW / 2, pageH - 12, { align: 'center' });
      }
    }

    const filename = `ROTARACT_PSVPEC_${(session.serviceType || 'Attendance').replace(/[^a-zA-Z0-9]/g, '_')}_${session.eventName?.replace(/[^a-zA-Z0-9]/g, '_') || 'Report'}_${session.date || 'undated'}.pdf`;

    if (download) {
      doc.save(filename);
      showToast('PDF exported successfully!', 'success');
    }
    return doc;
  } catch (err) {
    console.error('PDF export error:', err);
    showToast('Failed to export PDF. Please try again.', 'error');
    return null;
  }
}

// ============================================================
// EXCEL EXPORT
// ============================================================

function exportSessionExcel(sessionId) {
  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) {
    showToast('Session not found.', 'error');
    return;
  }

  try {
    const wb = XLSX.utils.book_new();
    const records = session.records || [];

    // Filter and sort all present records alphabetically
    const presentRecords = records
      .filter(r => r.status === 'Present')
      .sort((a, b) => (a.memberName || '').localeCompare(b.memberName || ''));

    // Construct unified sheet data structure matching PDF formatting
    const sheetData = [
      ['ROTARACT CLUB OF PSVPEC'],
      ['Official Attendance Report'],
      [],
      ['EVENT METADATA'],
      ['Service / Avenue:', session.serviceType || 'N/A'],
      ['Project Name:', session.eventName || 'Untitled Event'],
      ['Venue:', session.venue || 'N/A'],
      ['Event Date:', session.date || 'N/A'],
      ['Event Time:', formatTime12Hour(session.eventTime)],
      ['Total Attendees:', session.totalPresent || 0],
      [],
      ['ATTENDANCE SHEET'],
      ['#', 'Name', 'Status']
    ];

    presentRecords.forEach((r, i) => {
      sheetData.push([
        i + 1,
        (r.memberName || '').toUpperCase(),
        'Present'
      ]);
    });

    const sheet = XLSX.utils.aoa_to_sheet(sheetData);

    // Apply column widths for organized layout and prevent truncation
    sheet['!cols'] = [
      { wch: 20 },  // Column A: labels
      { wch: 35 },  // Column B: values / Name
      { wch: 15 }   // Column C: Status
    ];

    // Merge titles for professional layout
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },  // ROTARACT CLUB OF PSVPEC
      { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },  // Official Attendance Report
      { s: { r: 3, c: 0 }, e: { r: 3, c: 2 } },  // EVENT METADATA
      { s: { r: 11, c: 0 }, e: { r: 11, c: 2 } }  // ATTENDANCE SHEET
    ];

    XLSX.utils.book_append_sheet(wb, sheet, 'Attendance');

    const filename = `ROTARACT_PSVPEC_${(session.serviceType || 'Attendance').replace(/[^a-zA-Z0-9]/g, '_')}_${session.eventName?.replace(/[^a-zA-Z0-9]/g, '_') || 'Report'}_${session.date || 'undated'}.xlsx`;
    XLSX.writeFile(wb, filename);

    showToast('Excel exported successfully!', 'success');
  } catch (err) {
    console.error('Excel export error:', err);
    showToast('Failed to export Excel. Please try again.', 'error');
  }
}

// ============================================================
// SETTINGS HELPERS
// ============================================================
function updateSettingsCounts() {
  const memberCount = $('#settings-member-count');
  const sessionCount = $('#settings-session-count');
  if (memberCount) memberCount.textContent = `${APP.members.length} members`;
  if (sessionCount) sessionCount.textContent = `${APP.sessions.length} sessions`;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatTime12Hour(timeStr) {
  if (!timeStr) return 'N/A';
  const [hourStr, minuteStr] = timeStr.split(':');
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr || '00';
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  hour = hour ? hour : 12; // the hour '0' should be '12'
  return `${hour}:${minute} ${ampm}`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

const ANIMATED_COUNTERS = new Set();

function animateCounter(el, target, suffix = '', prefix = '') {
  if (!el) return;

  const elementId = el.id || el.className || el.tagName;

  // Cancel any existing animation on this element to prevent race conditions
  if (el._animationFrameId) {
    cancelAnimationFrame(el._animationFrameId);
    el._animationFrameId = null;
  }

  // If this element has already been animated in this session, skip and set target value immediately
  if (elementId && ANIMATED_COUNTERS.has(elementId)) {
    el.textContent = prefix + target + suffix;
    return;
  }

  if (elementId) {
    ANIMATED_COUNTERS.add(elementId);
  }

  // Handle fractions like "68/92"
  if (typeof target === 'string' && target.includes('/')) {
    const parts = target.split('/');
    const firstNum = parseInt(parts[0]) || 0;
    const secondNum = parseInt(parts[1]) || 0;

    const start = 0;
    const duration = 1000;
    let startTime = null;
    const easeOutQuad = (t) => t * (2 - t);

    const step = (timestamp) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const easedProgress = easeOutQuad(progress);
      const currentValue = Math.floor(start + (firstNum - start) * easedProgress);

      el.textContent = prefix + `${currentValue}/${secondNum}` + suffix;

      if (progress < 1) {
        el._animationFrameId = window.requestAnimationFrame(step);
      } else {
        el.textContent = prefix + target + suffix;
        el._animationFrameId = null;
      }
    };
    el._animationFrameId = window.requestAnimationFrame(step);
    return;
  }

  const targetNum = parseInt(target) || 0;
  const start = 0;
  const duration = 1000; // 1 second
  let startTime = null;

  const easeOutQuad = (t) => t * (2 - t);

  const step = (timestamp) => {
    if (!startTime) startTime = timestamp;
    const progress = Math.min((timestamp - startTime) / duration, 1);
    const easedProgress = easeOutQuad(progress);
    const currentValue = Math.floor(start + (targetNum - start) * easedProgress);

    el.textContent = prefix + currentValue + suffix;

    if (progress < 1) {
      el._animationFrameId = window.requestAnimationFrame(step);
    } else {
      el.textContent = prefix + target + suffix;
      el._animationFrameId = null;
    }
  };

  el._animationFrameId = window.requestAnimationFrame(step);
}

// ============================================================
// ACCESS CONTROL & ROLE MANAGEMENT MODULE
// ============================================================

async function checkUserRole(user) {
  const userEmail = user.email.toLowerCase();

  // Guarantee instant master admin access to prevent lockouts
  if (userEmail === 'durkeshwaran14@gmail.com') {
    // Attempt to register/verify in Firestore asynchronously in the background
    try {
      const docRef = db.collection('userRoles').doc(userEmail);
      const docSnap = await docRef.get();
      if (!docSnap.exists || !docSnap.data()?.active) {
        await docRef.set({
          uid: user.uid,
          email: userEmail,
          displayName: 'Durkeshwaran',
          clubPosition: 'Sergeant',
          accessMode: 'admin',
          active: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: 'system'
        });
      }
    } catch (e) {
      console.warn('Background master admin registration skipped:', e);
    }

    return {
      uid: user.uid,
      email: userEmail,
      displayName: 'Durkeshwaran',
      clubPosition: 'Sergeant',
      accessMode: 'admin',
      active: true
    };
  }

  // Regular users
  const docRef = db.collection('userRoles').doc(userEmail);
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    return { accessMode: 'viewer', active: true, guest: true };
  }

  const roleData = docSnap.data();
  if (!roleData) {
    return { accessMode: 'viewer', active: true, guest: true };
  }

  return roleData;
}

function applyAccessControlRules() {
  const mode = APP.userRole ? APP.userRole.accessMode : 'viewer';

  if (mode === 'admin') {
    // Show Admin Tabs
    $$('#nav-tabs [data-tab="attendance"], #mobile-nav [data-tab="attendance"]').forEach(el => el.classList.remove('hidden'));
    $$('#nav-tabs [data-tab="members"], #mobile-nav [data-tab="members"]').forEach(el => el.classList.remove('hidden'));
    $$('#nav-tabs [data-tab="settings"], #mobile-nav [data-tab="settings"]').forEach(el => el.classList.remove('hidden'));
    $('#settings-access-control-card')?.classList.remove('hidden');
    $('#settings-drive-sync-card')?.classList.remove('hidden');
    $$('.admin-only').forEach(el => el.classList.remove('hidden'));

    // Toggle header actions
    $('#admin-access-btn')?.classList.add('hidden');
    $('#user-role-badge')?.classList.remove('hidden');
    $('#logout-btn')?.classList.remove('hidden');
  } else {
    // Hide Protected Tabs
    $$('#nav-tabs [data-tab="attendance"], #mobile-nav [data-tab="attendance"]').forEach(el => el.classList.add('hidden'));
    $$('#nav-tabs [data-tab="members"], #mobile-nav [data-tab="members"]').forEach(el => el.classList.add('hidden'));
    $$('#nav-tabs [data-tab="settings"], #mobile-nav [data-tab="settings"]').forEach(el => el.classList.add('hidden'));
    $('#settings-access-control-card')?.classList.add('hidden');
    $('#settings-drive-sync-card')?.classList.add('hidden');
    $$('.admin-only').forEach(el => el.classList.add('hidden'));

    // Toggle header actions
    if (auth.currentUser) {
      $('#admin-access-btn')?.classList.add('hidden');
      $('#user-role-badge')?.classList.remove('hidden');
      $('#logout-btn')?.classList.remove('hidden');
    } else {
      $('#admin-access-btn')?.classList.remove('hidden');
      $('#user-role-badge')?.classList.add('hidden');
      $('#logout-btn')?.classList.add('hidden');
    }

    // Redirect viewer if on a prohibited tab
    if (['attendance', 'members', 'settings'].includes(APP.currentTab)) {
      switchTab('dashboard');
    }
  }
}

async function handleBlockedLogout() {
  try {
    await auth.signOut();
    showToast('Signed out successfully', 'info');
  } catch (err) {
    showToast('Logout failed', 'error');
  }
}

async function fetchUserRoles() {
  try {
    const snapshot = await db.collection('userRoles').orderBy('email').get();
    APP.userRoles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error('Error fetching user roles:', err);
    throw err;
  }
}

function renderUserRoles() {
  const container = $('#role-users-list');
  if (!container) return;

  const searchQuery = ($('#role-search')?.value || '').toLowerCase().trim();
  let filtered = APP.userRoles;

  if (searchQuery) {
    filtered = filtered.filter(u => (u.email || '').toLowerCase().includes(searchQuery));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="5" class="text-center" style="padding:20px; color:var(--text-tertiary);">
          No user roles found.
        </td>
      </tr>`;
    return;
  }

  container.innerHTML = filtered.map(u => {
    const statusText = u.active ? 'Active' : 'Inactive';
    const statusClass = u.active ? 'badge-present' : 'badge-absent';
    const modeClass = u.accessMode === 'admin' ? 'badge-board' : 'badge-other';

    // Disable operations on own self to prevent accidental self-deletion or lockout
    const isSelf = auth.currentUser && auth.currentUser.email.toLowerCase() === u.email.toLowerCase();
    const actionButtons = isSelf ? `
      <span style="font-size:0.75rem; color:var(--text-tertiary); font-style:italic; padding-right:8px;">Current User</span>
    ` : `
      <button class="btn-icon" onclick="openEditRoleModal('${escapeHtml(u.email)}')" title="Edit User"><i class="fas fa-edit"></i></button>
      <button class="btn-icon" style="color:${u.active ? 'var(--danger)' : 'var(--success)'};" onclick="toggleUserActive('${escapeHtml(u.email)}', ${u.active})" title="${u.active ? 'Deactivate' : 'Activate'}">
        <i class="fas ${u.active ? 'fa-user-slash' : 'fa-user-check'}"></i>
      </button>
      <button class="btn-icon danger" onclick="deleteUserRole('${escapeHtml(u.email)}')" title="Delete User"><i class="fas fa-trash-alt"></i></button>
    `;

    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:12px 10px; font-weight:600; word-break:break-all;">${escapeHtml(u.email)}</td>
        <td style="padding:12px 10px;">${escapeHtml(u.clubPosition)}</td>
        <td style="padding:12px 10px;"><span class="badge ${modeClass}">${escapeHtml(u.accessMode)}</span></td>
        <td style="padding:12px 10px;"><span class="badge ${statusClass}">${statusText}</span></td>
        <td style="padding:12px 10px; text-align:right;">
          <div style="display:flex; justify-content:flex-end; gap:8px; align-items:center;">
            ${actionButtons}
          </div>
        </td>
      </tr>`;
  }).join('');
}

function openAddRoleModal() {
  APP.editingUserRoleEmail = null;
  $('#role-modal-title').textContent = 'Add User Access';
  $('#role-email').value = '';
  $('#role-email').disabled = false;
  $('#role-position').value = '';
  $('#role-mode').value = 'viewer';
  $('#role-active').value = 'true';
  showModal('role-modal');
}

function openEditRoleModal(email) {
  const userRole = APP.userRoles.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!userRole) return;

  APP.editingUserRoleEmail = email;
  $('#role-modal-title').textContent = 'Edit User Access';
  $('#role-email').value = userRole.email;
  $('#role-email').disabled = true; // Email is the identifier, cannot be modified
  $('#role-position').value = userRole.clubPosition;
  $('#role-mode').value = userRole.accessMode;
  $('#role-active').value = String(userRole.active);
  showModal('role-modal');
}

function autoAssignAccessMode() {
  const pos = $('#role-position').value;
  const modeInput = $('#role-mode');
  if (!modeInput) return;

  if (pos === 'Sergeant') {
    modeInput.value = 'admin';
  } else {
    modeInput.value = 'viewer';
  }
}

async function saveUserRole(event) {
  event.preventDefault();

  if (!APP.userRole || APP.userRole.accessMode !== 'admin') {
    showToast('Permission Denied', 'error');
    return;
  }

  const email = $('#role-email').value.trim().toLowerCase();
  const position = $('#role-position').value;
  const accessMode = $('#role-mode').value;
  const active = $('#role-active').value === 'true';

  if (!email || !position) {
    showToast('Please fill all required fields.', 'warning');
    return;
  }

  const btn = $('#save-role-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const docRef = db.collection('userRoles').doc(email);

    if (APP.editingUserRoleEmail) {
      // Edit mode
      await docRef.update({
        clubPosition: position,
        accessMode,
        active,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      showToast('Access role updated successfully.', 'success');
    } else {
      // Create mode
      const existing = await docRef.get();
      if (existing.exists) {
        showToast('This user email already has a configured role.', 'warning');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> Save Access';
        return;
      }

      const newRole = {
        email,
        uid: '', // Linked on first login
        displayName: email.split('@')[0],
        clubPosition: position,
        accessMode,
        active,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: auth.currentUser?.email || 'unknown'
      };

      await docRef.set(newRole);
      showToast('New access role added.', 'success');
    }

    hideModal('role-modal');
    await fetchUserRoles();
    renderUserRoles();
  } catch (err) {
    console.error('Error saving user role:', err);
    showToast('Failed to save user role mappings.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Access';
  }
}

async function toggleUserActive(email, currentStatus) {
  if (!APP.userRole || APP.userRole.accessMode !== 'admin') {
    showToast('Permission Denied', 'error');
    return;
  }

  try {
    await db.collection('userRoles').doc(email).update({
      active: !currentStatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast(`User status set to ${!currentStatus ? 'Active' : 'Inactive'}.`, 'success');
    await fetchUserRoles();
    renderUserRoles();
  } catch (err) {
    console.error('Error toggling active state:', err);
    showToast('Failed to update status.', 'error');
  }
}

function deleteUserRole(email) {
  if (!APP.userRole || APP.userRole.accessMode !== 'admin') {
    showToast('Permission Denied', 'error');
    return;
  }

  showConfirm(
    'Delete Access Rule?',
    `Are you sure you want to delete access credentials for ${email}?`,
    async () => {
      try {
        await db.collection('userRoles').doc(email).delete();
        showToast('User access role deleted.', 'success');
        await fetchUserRoles();
        renderUserRoles();
      } catch (err) {
        console.error('Error deleting user role:', err);
        showToast('Failed to delete access rule.', 'error');
      }
    },
    'danger'
  );
}

// ============================================================
// GOOGLE DRIVE CLIENT-SIDE SYNC ENGINE
// ============================================================

let tokenClient;
let gisInited = false;
let gapiInited = false;

// 1. Load & Save Settings
async function fetchDriveSettings() {
  try {
    const doc = await db.collection('settings').doc('googleDrive').get();
    const dbData = doc.exists ? doc.data() : {};

    // Merge database configurations with static appConfig parameters
    APP.driveSettings = {
      driveConnected: dbData.driveConnected || false,
      googleClientId: appConfig.GOOGLE_OAUTH_CLIENT_ID,
      driveFolderName: dbData.driveFolderName || appConfig.DEFAULT_DRIVE_FOLDER || 'Rotaract_Attendance',
      driveFolderId: dbData.driveFolderId || '',
      autoUpload: dbData.autoUpload || false,
      organizeYearMonth: dbData.organizeYearMonth !== false && appConfig.ORGANIZE_BY_YEAR_MONTH !== false,
      lastSync: dbData.lastSync || null,
      lastUpload: dbData.lastUpload || '',
      lastUploadStatus: dbData.lastUploadStatus || ''
    };

    populateDriveSettingsUI();
  } catch (err) {
    console.error('Error fetching Google Drive settings:', err);
  }
}

function populateDriveSettingsUI() {
  if (!APP.driveSettings) return;

  const nameInput = $('#drive-folder-name');
  const idFolderInput = $('#drive-folder-id');
  const autoCheckbox = $('#drive-auto-upload');
  const subfolderCheckbox = $('#drive-year-month-folders');

  if (nameInput) nameInput.value = APP.driveSettings.driveFolderName || 'Rotaract_Attendance';
  if (idFolderInput) idFolderInput.value = APP.driveSettings.driveFolderId || '';
  if (autoCheckbox) autoCheckbox.checked = APP.driveSettings.autoUpload || false;
  if (subfolderCheckbox) subfolderCheckbox.checked = APP.driveSettings.organizeYearMonth !== false;

  // Set origin URL dynamically
  const originDisplay = $('#origin-url-display');
  if (originDisplay) originDisplay.textContent = window.location.origin;

  // Last Sync display
  updateLastSyncUI();
}

function updateLastSyncUI() {
  if (!APP.driveSettings) return;
  const infoContainer = $('#drive-sync-info');
  const fileEl = $('#drive-last-file');
  const timeEl = $('#drive-last-time');
  const statusEl = $('#drive-last-status');

  if (!infoContainer) return;

  if (APP.driveSettings.lastSync) {
    infoContainer.classList.remove('hidden');
    if (fileEl) fileEl.textContent = APP.driveSettings.lastUpload || 'N/A';
    if (timeEl) {
      const date = new Date(APP.driveSettings.lastSync.seconds * 1000);
      timeEl.textContent = date.toLocaleString();
    }
    if (statusEl) {
      statusEl.textContent = APP.driveSettings.lastUploadStatus || 'N/A';
      if (APP.driveSettings.lastUploadStatus === 'Success') {
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.style.color = 'var(--danger)';
      }
    }
  } else {
    infoContainer.classList.add('hidden');
  }
}

async function saveDriveSettings() {
  const nameVal = $('#drive-folder-name')?.value.trim() || 'Rotaract_Attendance';
  const idVal = $('#drive-folder-id')?.value.trim() || '';
  const autoVal = $('#drive-auto-upload')?.checked || false;
  const subfolderVal = $('#drive-year-month-folders')?.checked || false;

  const btn = $('#save-drive-settings-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    const updateData = {
      driveFolderName: nameVal,
      driveFolderId: idVal,
      autoUpload: autoVal,
      organizeYearMonth: subfolderVal
    };

    await db.collection('settings').doc('googleDrive').set(updateData, { merge: true });
    Object.assign(APP.driveSettings, updateData);
    showToast('Google Drive sync settings updated.', 'success');
  } catch (err) {
    console.error('Error saving settings:', err);
    showToast('Failed to save Drive settings.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save" style="margin-right:6px;"></i>Save Settings';
  }
}

function updateDriveStatusUI(status, message = '') {
  const badge = $('#drive-status-badge');
  const connectBtn = $('#drive-connect-btn');
  const disconnectBtn = $('#drive-disconnect-btn');
  const spinner = $('#drive-status-spinner');

  if (!badge) return;

  if (spinner) spinner.style.display = 'none';

  if (status === 'connected') {
    badge.className = 'badge badge-present';
    badge.textContent = 'Connected';
    if (connectBtn) connectBtn.classList.add('hidden');
    if (disconnectBtn) disconnectBtn.classList.remove('hidden');

    const chooseBtn = $('#drive-choose-folder-btn');
    const testBtn = $('#drive-test-btn');
    if (chooseBtn) chooseBtn.disabled = false;
    if (testBtn) testBtn.disabled = false;
  } else {
    badge.className = 'badge badge-absent';
    badge.textContent = message || 'Not Connected';
    if (connectBtn) connectBtn.classList.remove('hidden');
    if (disconnectBtn) disconnectBtn.classList.add('hidden');

    const chooseBtn = $('#drive-choose-folder-btn');
    const testBtn = $('#drive-test-btn');
    if (chooseBtn) chooseBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
  }
}

// 2. GIS Initialization & Connection
function initGoogleClient() {
  const clientId = appConfig.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId || clientId.includes('xxxx')) {
    console.warn('Google Client ID is missing or invalid in app-config.js.');
    updateDriveStatusUI('disconnected', 'Client ID not set');
    return;
  }

  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    console.warn('Google Identity Services library not yet loaded. Retrying in 500ms...');
    setTimeout(initGoogleClient, 500);
    return;
  }

  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
      callback: async (response) => {
        if (response.error !== undefined) {
          console.error('Google OAuth connection error:', response);
          showToast('Failed to connect to Google Drive.', 'error');
          updateDriveStatusUI('disconnected', 'Auth failed');
          return;
        }

        APP.googleAccessToken = response.access_token;
        APP.googleTokenExpiry = Date.now() + (response.expires_in * 1000);

        APP.driveSettings.driveConnected = true;
        await db.collection('settings').doc('googleDrive').set({ driveConnected: true }, { merge: true });
        updateDriveStatusUI('connected');
        showToast('Google Account authorized successfully!', 'success');

        // Auto-bootstrap base folders in Drive
        getOrCreateDriveFolder();
      }
    });
    gisInited = true;

    if (APP.driveSettings.driveConnected) {
      updateDriveStatusUI('disconnected', 'Requires Login');
    } else {
      updateDriveStatusUI('disconnected', 'Not Connected');
    }
  } catch (err) {
    console.error('Error initializing Google Client:', err);
    updateDriveStatusUI('disconnected', 'GIS Error');
  }
}

function connectGoogleDrive() {
  if (!tokenClient) {
    showToast('Google Client is not initialized.', 'warning');
    return;
  }
  const loginHint = appConfig.LOGIN_HINT_EMAIL || 'serg.racpsvpec@gmail.com';
  tokenClient.requestAccessToken({
    prompt: 'consent',
    login_hint: loginHint
  });
}

async function disconnectGoogleDrive() {
  try {
    if (APP.googleAccessToken) {
      google.accounts.oauth2.revoke(APP.googleAccessToken);
    }
  } catch (e) {
    console.warn('Token revocation failed:', e);
  }

  APP.googleAccessToken = null;
  APP.googleTokenExpiry = null;
  APP.driveSettings.driveConnected = false;

  try {
    await db.collection('settings').doc('googleDrive').set({ driveConnected: false }, { merge: true });
    showToast('Google Drive disconnected.', 'info');
    updateDriveStatusUI('disconnected', 'Disconnected');
  } catch (err) {
    console.error('Disconnect update failed:', err);
  }
}

async function ensureValidAccessToken() {
  if (APP.googleAccessToken && Date.now() < APP.googleTokenExpiry - 60000) {
    return APP.googleAccessToken;
  }

  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Google Client ID is not configured.'));
      return;
    }

    const originalCallback = tokenClient.callback;
    tokenClient.callback = async (response) => {
      tokenClient.callback = originalCallback;

      if (response.error !== undefined) {
        reject(new Error('Google Auth Failed: ' + response.error));
        return;
      }

      APP.googleAccessToken = response.access_token;
      APP.googleTokenExpiry = Date.now() + (response.expires_in * 1000);

      APP.driveSettings.driveConnected = true;
      await db.collection('settings').doc('googleDrive').set({ driveConnected: true }, { merge: true });
      updateDriveStatusUI('connected');

      resolve(response.access_token);
    };

    const loginHint = appConfig.LOGIN_HINT_EMAIL || 'serg.racpsvpec@gmail.com';
    tokenClient.requestAccessToken({
      prompt: '',
      login_hint: loginHint
    });
  });
}

// 3. Drive Folders Lookup & Creation
async function getOrCreateDriveFolder() {
  try {
    const accessToken = await ensureValidAccessToken();
    const folderName = APP.driveSettings.driveFolderName || 'Rotaract_Attendance';
    const savedFolderId = APP.driveSettings.driveFolderId || '';

    // Validate saved folder ID first (fastest path — no name ambiguity)
    if (savedFolderId) {
      const testUrl = `https://www.googleapis.com/drive/v3/files/${savedFolderId}?fields=id,name,trashed`;
      const testRes = await fetch(testUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (testRes.ok) {
        const fileInfo = await testRes.json();
        if (!fileInfo.trashed) {
          return savedFolderId;
        }
      }
    }

    // Search for existing root folder by name — scoped to Drive root only
    // Using 'root' in parents prevents matching nested folders with the same name
    const query = `name = '${folderName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        const folderId = searchData.files[0].id;
        // Keep stored folder ID in sync
        if (savedFolderId !== folderId) {
          APP.driveSettings.driveFolderId = folderId;
          await db.collection('settings').doc('googleDrive').update({ driveFolderId: folderId });
          const idInput = $('#drive-folder-id');
          if (idInput) idInput.value = folderId;
        }
        return folderId;
      }
    }

    // Create new folder explicitly in Drive root
    const createUrl = `https://www.googleapis.com/drive/v3/files`;
    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root']
    };

    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(folderMetadata)
    });

    if (!createRes.ok) throw new Error('Folder creation request failed.');
    const folder = await createRes.json();

    APP.driveSettings.driveFolderId = folder.id;
    await db.collection('settings').doc('googleDrive').update({ driveFolderId: folder.id });

    const idInput = $('#drive-folder-id');
    if (idInput) idInput.value = folder.id;

    showToast(`Created folder "${folderName}" in Drive.`, 'success');
    return folder.id;
  } catch (err) {
    console.error('Error getting or creating drive folder:', err);
    throw err;
  }
}

// Concurrency lock to prevent parallel createYearMonthFolders calls from creating duplicates
let _yearMonthFolderLock = Promise.resolve();

async function createYearMonthFolders(parentFolderId, dateStr) {
  // Serialise all Year/Month folder operations through a single queue
  // This prevents two parallel uploads from both seeing "July doesn't exist" and both creating it
  const result = _yearMonthFolderLock = _yearMonthFolderLock
    .catch(() => {}) // Don't let a previous failure block the queue
    .then(() => _createYearMonthFoldersImpl(parentFolderId, dateStr));
  return result;
}

async function _createYearMonthFoldersImpl(parentFolderId, dateStr) {
  try {
    const accessToken = await ensureValidAccessToken();
    const dateObj = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
    const year = String(dateObj.getFullYear());
    const month = dateObj.toLocaleString('en', { month: 'long' }); // e.g. July

    // Helper: search for an existing child folder by name inside a specific parent
    async function findChildFolder(parentId, childName) {
      const query = `name = '${childName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.files && data.files.length > 0) ? data.files[0].id : null;
    }

    // Helper: create a child folder inside a specific parent
    async function createChildFolder(parentId, childName) {
      const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: childName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        })
      });
      if (!res.ok) throw new Error(`Failed to create folder "${childName}"`);
      const folder = await res.json();
      return folder.id;
    }

    // 1. Get or Create Year Folder (e.g. "2026" inside Rotaract_Attendance)
    let yearFolderId = await findChildFolder(parentFolderId, year);
    if (!yearFolderId) {
      yearFolderId = await createChildFolder(parentFolderId, year);
      console.log(`Created year folder: ${year} (${yearFolderId})`);
    }

    // 2. Get or Create Month Folder (e.g. "July" inside 2026)
    let monthFolderId = await findChildFolder(yearFolderId, month);
    if (!monthFolderId) {
      monthFolderId = await createChildFolder(yearFolderId, month);
      console.log(`Created month folder: ${month} (${monthFolderId})`);
    }

    return monthFolderId;
  } catch (err) {
    console.error('Error creating Year/Month folders:', err);
    throw err;
  }
}

// 4. Picker API Loading
function loadGooglePicker() {
  if (!APP.googleAccessToken) {
    connectGoogleDrive();
    return;
  }
  if (!window.gapi || !window.gapi.load) {
    showToast('Google API library is loading. Please try again in a moment.', 'warning');
    return;
  }
  gapi.load('client:picker', {
    callback: () => {
      createPicker(APP.googleAccessToken);
    }
  });
}

function createPicker(accessToken) {
  try {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setMimeTypes('application/vnd.google-apps.folder')
      .setSelectFolderEnabled(true);

    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setCallback(pickerCallback)
      .setTitle('Select Rotaract Attendance folder')
      .build();

    picker.setVisible(true);
  } catch (err) {
    console.error('Error loading Google Picker:', err);
    showToast('Failed to load Google Picker UI.', 'error');
  }
}

function pickerCallback(data) {
  if (data.action === google.picker.Action.PICKED) {
    const folder = data.docs[0];
    const idInput = $('#drive-folder-id');
    const nameInput = $('#drive-folder-name');

    if (idInput) idInput.value = folder.id;
    if (nameInput) nameInput.value = folder.name;

    showToast(`Folder selected: ${folder.name}`, 'success');
  }
}

// 5. PDF Upload logic
async function uploadSessionPDFToDrive(sessionId) {
  const session = APP.sessions.find(s => s.id === sessionId);
  if (!session) return;

  // Set UI state to Syncing
  session.uploadStatus = 'Syncing';
  renderReportsList();

  try {
    showToast(`Syncing "${session.eventName}" to Google Drive...`, 'info');

    // Get valid access token
    const accessToken = await ensureValidAccessToken();

    // Retrieve parent folder ID
    const rootFolderId = await getOrCreateDriveFolder();
    let targetFolderId = rootFolderId;

    // Check for subfolder structure
    if (APP.driveSettings.organizeYearMonth !== false) {
      targetFolderId = await createYearMonthFolders(rootFolderId, session.date);
    }

    // Generate PDF in-memory (download=false dry run)
    const doc = await exportSessionPDF(sessionId, false);
    if (!doc) throw new Error('PDF generation failed.');

    const blob = doc.output('blob');

    // Auto File Naming format: EventName_Date.pdf
    const safeName = (session.eventName || 'Report').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${safeName}_${session.date || 'undated'}.pdf`;

    // Execute Multipart File Upload (use existing fileId if available)
    let uploadResult;
    try {
      uploadResult = await sendPDFToGoogleDrive(blob, filename, targetFolderId, session.fileId);
    } catch (err) {
      if (session.fileId && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('403') || err.message.includes('Upload Failed (404)') || err.message.includes('Upload Failed (403)'))) {
        console.warn('Existing file not found or inaccessible in Drive. Creating a new one...');
        uploadResult = await sendPDFToGoogleDrive(blob, filename, targetFolderId, null);
      } else {
        throw err;
      }
    }

    const fileId = uploadResult.id;
    const fileUrl = uploadResult.webViewLink;

    // Save details to Firestore
    const updatePayload = {
      uploadStatus: 'Synced',
      fileId,
      fileUrl,
      uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
      uploadedBy: auth.currentUser?.email || 'unknown',
      driveFolderId: targetFolderId
    };

    await db.collection('sessions').doc(sessionId).update(updatePayload);

    // Sync Local App State
    Object.assign(session, updatePayload);

    // Save last synced info in global settings
    const settingSyncUpdate = {
      lastSync: firebase.firestore.FieldValue.serverTimestamp(),
      lastUpload: filename,
      lastUploadStatus: 'Success'
    };
    await db.collection('settings').doc('googleDrive').update(settingSyncUpdate);
    if (APP.driveSettings) {
      Object.assign(APP.driveSettings, settingSyncUpdate);
      APP.driveSettings.lastSync = { seconds: Date.now() / 1000 };
    }

    showToast(`"${filename}" uploaded to Google Drive.`, 'success');

    // UI refreshes
    renderReportsList();
    if (APP.currentTab === 'settings') {
      updateLastSyncUI();
    }

  } catch (err) {
    console.error('Google Drive Sync error:', err);
    showToast('Failed to upload PDF to Google Drive.', 'error');

    // Mark status in DB and State
    try {
      await db.collection('sessions').doc(sessionId).update({ uploadStatus: 'Failed' });
      session.uploadStatus = 'Failed';
      renderReportsList();

      const settingSyncUpdate = {
        lastSync: firebase.firestore.FieldValue.serverTimestamp(),
        lastUpload: `${session.eventName}_${session.date}.pdf`,
        lastUploadStatus: 'Failed: ' + err.message
      };
      await db.collection('settings').doc('googleDrive').update(settingSyncUpdate);
      if (APP.driveSettings) {
        Object.assign(APP.driveSettings, settingSyncUpdate);
        APP.driveSettings.lastSync = { seconds: Date.now() / 1000 };
        updateLastSyncUI();
      }
    } catch (e) {
      console.warn('Fail status write failed:', e);
    }
  }
}

async function sendPDFToGoogleDrive(pdfBlob, filename, parentFolderId, fileId = null) {
  const accessToken = await ensureValidAccessToken();

  // Multipart body composition
  const metadata = {
    name: filename,
    mimeType: 'application/pdf'
  };
  if (!fileId) {
    metadata.parents = [parentFolderId];
  }

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', pdfBlob);

  const uploadUrl = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,webViewLink`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';

  const res = await fetch(uploadUrl, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    },
    body: formData
  });

  if (!res.ok) {
    const errorDetails = await res.text();
    throw new Error(`Upload Failed (${res.status}): ${errorDetails}`);
  }

  return await res.json();
}

async function cleanUpIncorrectDriveFolders(rootFolderId, accessToken) {
  try {
    const listUrl = (parentId) => `https://www.googleapis.com/drive/v3/files?q='${parentId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType)`;

    const trashFile = async (fileId) => {
      const trashUrl = `https://www.googleapis.com/drive/v3/files/${fileId}`;
      await fetch(trashUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ trashed: true })
      });
    };

    // Move files from a source folder to a destination folder before trashing the source
    const rescueFilesFromFolder = async (sourceFolderId, destFolderId) => {
      const filesRes = await fetch(listUrl(sourceFolderId), { headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (!filesRes.ok) return;
      const filesData = await filesRes.json();
      const files = filesData.files || [];
      for (const file of files) {
        if (file.mimeType !== 'application/vnd.google-apps.folder') {
          // Move PDF file: remove old parent, add correct parent
          await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?addParents=${destFolderId}&removeParents=${sourceFolderId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          console.log(`Rescued file "${file.name}" from duplicate folder to correct location.`);
        }
      }
    };

    const validMonths = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    // 1. Get all items in the root Rotaract_Attendance folder
    let res = await fetch(listUrl(rootFolderId), { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!res.ok) return;
    let data = await res.json();
    const rootItems = data.files || [];

    for (const item of rootItems) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const isYear = /^\d{4}$/.test(item.name);
        if (!isYear) {
          console.log(`Trashing invalid folder in root: ${item.name}`);
          await trashFile(item.id);
        } else {
          // Check inside the valid year folder for invalid items
          let yearRes = await fetch(listUrl(item.id), { headers: { 'Authorization': `Bearer ${accessToken}` } });
          if (yearRes.ok) {
            let yearData = await yearRes.json();
            const yearItems = yearData.files || [];

            for (const yearItem of yearItems) {
              if (yearItem.mimeType === 'application/vnd.google-apps.folder') {
                const isMonth = validMonths.includes(yearItem.name);
                if (!isMonth) {
                  console.log(`Trashing invalid folder inside Year ${item.name}: ${yearItem.name}`);
                  await trashFile(yearItem.id);
                } else {
                  // Inside valid month folder — trash any rogue subfolders (e.g. duplicate "2026" inside "July")
                  let monthRes = await fetch(listUrl(yearItem.id), { headers: { 'Authorization': `Bearer ${accessToken}` } });
                  if (monthRes.ok) {
                    let monthData = await monthRes.json();
                    const monthItems = monthData.files || [];
                    for (const monthItem of monthItems) {
                      if (monthItem.mimeType === 'application/vnd.google-apps.folder') {
                        console.log(`Trashing nested duplicate folder "${monthItem.name}" inside ${item.name}/${yearItem.name}`);
                        // Rescue any PDFs trapped inside the rogue subfolder first
                        await rescueFilesFromFolder(monthItem.id, yearItem.id);
                        await trashFile(monthItem.id);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    console.log('Drive folder cleanup completed successfully.');
  } catch (err) {
    console.error('Error cleaning up Drive folders:', err);
  }
}

// 6. Test Connection
async function testDriveConnection() {
  const btn = $('#drive-test-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin" style="margin-right:6px;"></i>Testing...';

  try {
    const accessToken = await ensureValidAccessToken();

    // Try listing files in target folder to check permissions
    const folderId = await getOrCreateDriveFolder();
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&pageSize=3&fields=files(id,name)`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      throw new Error(`Permission check failed: ${res.status}`);
    }

    // Run clean up on incorrect folders automatically
    await cleanUpIncorrectDriveFolders(folderId, accessToken);

    showToast('Drive connection test passed and folders cleaned up!', 'success');
  } catch (err) {
    console.error('Drive connection test error:', err);
    showToast('Connection check failed. Please check client permissions.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sync" style="margin-right:6px;"></i>Test Connection';
  }
}
