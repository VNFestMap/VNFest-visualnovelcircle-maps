(function () {
  'use strict';
  let returnFocus = null;
  const ja = () => window.VNFLanguage?.getLanguage?.() === 'ja' || document.documentElement.lang.startsWith('ja');
  const text = (zh, jp) => ja() ? jp : zh;

  function resetPasswords(root) {
    root.querySelectorAll('.auth-password-toggle').forEach(button => {
      const input = document.getElementById(button.getAttribute('aria-controls'));
      input.type = 'password';
      button.setAttribute('aria-pressed', 'false');
      labelPassword(button);
    });
  }
  function labelPassword(button) {
    const visible = button.getAttribute('aria-pressed') === 'true';
    const label = visible ? text('隐藏', '隠す') : text('显示', '表示');
    const accessibleLabel = visible ? text('隐藏密码', 'パスワードを隠す') : text('显示密码', 'パスワードを表示');
    // PageI18n updates lang while translating mutations: only write changed labels.
    if (button.textContent !== label) button.textContent = label;
    if (button.getAttribute('aria-label') !== accessibleLabel) button.setAttribute('aria-label', accessibleLabel);
  }
  function focusMissing(root) {
    if (!root) return;
    const input = [...root.querySelectorAll('input')].find(el => el.getClientRects().length && !el.disabled && !el.value.trim() && el.id !== 'regClubCode');
    if (input) input.focus({ preventScroll: true });
  }
  function message(el, value, kind = 'error') {
    if (!el) return;
    el.className = 'auth-msg' + (value ? ' ' + kind : '');
    el.style.color = '';
    el.textContent = value;
  }
  function open(modal, view) {
    const wasAuth = modal.classList.contains('account-auth');
    const isAuth = view === 'login' || view === 'register';
    modal.classList.toggle('account-auth', isAuth);
    if (!isAuth) return;
    if (!wasAuth || !modal.classList.contains('open')) returnFocus = document.activeElement;
    resetPasswords(modal);
    const title = modal.querySelector(view === 'login' ? '#accountLoginForm h2' : '#accountRegisterForm h2');
    title.id = view === 'login' ? 'accountLoginTitle' : 'accountRegisterTitle';
    modal.querySelector('[role="dialog"]').setAttribute('aria-labelledby', title.id);
    queueMicrotask(() => {
      if (!modal.classList.contains('open')) return;
      const input = modal.querySelector(view === 'login' ? '#accLoginUsername' : '#accRegUsername');
      input.focus({ preventScroll: true });
      modal.querySelector('.calendar-modal-scroll').scrollTop = 0;
    });
  }
  function close(modal) {
    resetPasswords(modal);
    if (modal.classList.contains('account-auth')) {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
    modal.classList.remove('account-auth');
    modal.querySelector('[role="dialog"]').removeAttribute('aria-labelledby');
  }
  function init() {
    document.querySelectorAll('.auth-view input[type="password"]').forEach(input => {
      const wrap = document.createElement('div');
      wrap.className = 'auth-password';
      input.before(wrap);
      wrap.append(input);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auth-password-toggle';
      button.setAttribute('aria-controls', input.id);
      button.setAttribute('aria-pressed', 'false');
      labelPassword(button);
      button.addEventListener('click', () => {
        const start = input.selectionStart, end = input.selectionEnd;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.setAttribute('aria-pressed', String(visible));
        labelPassword(button);
        input.focus({ preventScroll: true });
        if (start !== null) input.setSelectionRange(start, end);
      });
      wrap.append(button);
    });
    document.querySelectorAll('.auth-view .auth-msg').forEach(el => {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
    });
    new MutationObserver(() => document.querySelectorAll('.auth-password-toggle').forEach(labelPassword))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    document.addEventListener('keydown', event => {
      const modal = document.getElementById('accountModal');
      if (!modal?.classList.contains('open') || !modal.classList.contains('account-auth')) return;
      if (event.isComposing || event.keyCode === 229) return;
      // A nested dialog (e.g. avatar cropping) owns its own keyboard handling.
      if (event.key === 'Escape') { event.preventDefault(); window.closeAccountModal(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
  }
  window.VNAuthUI = { open, close, message, focusMissing, resetPasswords };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
