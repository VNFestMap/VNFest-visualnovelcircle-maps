(function () {
  'use strict';

  var page = document.querySelector('.wiki-reading-page');
  if (!page) return;

  var STORAGE_KEY = 'vnfestWikiAppearance';
  var DEFAULTS = { font: 'medium', width: 'standard', leading: 'standard', theme: 'light' };
  var allowed = {
    font: ['small', 'medium', 'large'],
    width: ['narrow', 'standard', 'wide'],
    leading: ['compact', 'standard', 'loose'],
    theme: ['light', 'paper', 'dark'],
  };
  var appearance = readAppearance();
  var observer = null;
  var highlightTimer = null;
  var sectionFrame = null;
  var activeSectionId = '';
  var pendingSectionId = '';
  var pendingSectionTimer = null;
  var appearanceRailHidden = false;
  var appearancePopoverOpen = false;

  function isolateReaderFromWallpaper() {
    document.documentElement.classList.remove('has-vnfest-wallpaper');
    var layer = document.getElementById('vnfestWallpaperLayer');
    if (layer) layer.remove();
    var wallpaperStyle = document.getElementById('vnfestWallpaperStyle');
    if (wallpaperStyle) wallpaperStyle.remove();
  }

  function validLanguage(value) {
    return value === 'ja' || value === 'zh' ? value : null;
  }

  function urlLanguage() {
    try {
      return validLanguage(new URLSearchParams(window.location.search).get('lang'));
    } catch (error) {
      return null;
    }
  }

  function currentLanguage() {
    return urlLanguage() || validLanguage(page.dataset.wikiPageLang) || (window.VNFLanguage && window.VNFLanguage.getLanguage() === 'ja' ? 'ja' : 'zh');
  }

  function readAppearance() {
    var next = Object.assign({}, DEFAULTS);
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      Object.keys(next).forEach(function (key) {
        if (allowed[key].indexOf(stored[key]) !== -1) next[key] = stored[key];
      });
    } catch (error) {}
    return next;
  }

  function saveAppearance() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance)); } catch (error) {}
  }

  function applyAppearance() {
    document.documentElement.dataset.wikiReaderTheme = appearance.theme;
    Object.keys(appearance).forEach(function (key) { page.dataset['wiki' + key.charAt(0).toUpperCase() + key.slice(1)] = appearance[key]; });
    page.querySelectorAll('[data-appearance-key]').forEach(function (button) {
      var active = appearance[button.dataset.appearanceKey] === button.dataset.appearanceValue;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncAppearanceRail();
  }

  function syncAppearanceRail() {
    var currentArticle = activeArticle();
    var launcher = page.querySelector('[data-appearance-launcher]') || document.querySelector('[data-appearance-launcher]');
    page.querySelectorAll('[data-wiki-article]').forEach(function (article) {
      var active = article === currentArticle;
      var rail = article.querySelector('[data-wiki-appearance]');
      if (!rail) return;
      article.classList.toggle('wiki-appearance-hidden', appearanceRailHidden && active);
      rail.classList.toggle('is-hidden', appearanceRailHidden && active);
      rail.classList.toggle('is-popover-open', appearanceRailHidden && appearancePopoverOpen && active);
      rail.setAttribute('aria-hidden', appearanceRailHidden && !(appearancePopoverOpen && active) ? 'true' : 'false');
      rail.querySelectorAll('[data-appearance-close]').forEach(function (button) { button.hidden = !(appearanceRailHidden && appearancePopoverOpen && active); });
      rail.querySelectorAll('[data-appearance-hide]').forEach(function (button) { button.hidden = appearanceRailHidden && appearancePopoverOpen && active; });
      rail.querySelectorAll('[data-appearance-dock]').forEach(function (button) { button.hidden = !(appearanceRailHidden && appearancePopoverOpen && active); });
    });
    if (launcher) {
      launcher.hidden = !(appearanceRailHidden && currentArticle);
      launcher.classList.toggle('is-visible', appearanceRailHidden && currentArticle);
      launcher.setAttribute('aria-expanded', appearanceRailHidden && appearancePopoverOpen && currentArticle ? 'true' : 'false');
    }
  }

  function hideAppearanceRail() {
    appearanceRailHidden = true;
    appearancePopoverOpen = false;
    page.querySelectorAll('[data-wiki-appearance]').forEach(function (rail) {
      rail.classList.remove('is-open');
      rail.querySelectorAll('[data-appearance-toggle]').forEach(function (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = '展开阅读设置';
      });
    });
    syncAppearanceRail();
  }

  function openAppearancePopover() {
    if (!appearanceRailHidden) return;
    appearancePopoverOpen = true;
    syncAppearanceRail();
    var rail = activeArticle() && activeArticle().querySelector('[data-wiki-appearance]');
    var close = rail && rail.querySelector('[data-appearance-close]');
    if (close) close.focus();
  }

  function closeAppearancePopover() {
    appearancePopoverOpen = false;
    syncAppearanceRail();
  }

  function restoreAppearanceRail() {
    appearanceRailHidden = false;
    appearancePopoverOpen = false;
    syncAppearanceRail();
    var rail = activeArticle() && activeArticle().querySelector('[data-wiki-appearance]');
    var hide = rail && rail.querySelector('[data-appearance-hide]');
    if (hide) hide.focus();
  }

  function activeArticle() {
    return page.querySelector('.wiki-article[data-wiki-lang]:not([hidden])');
  }

  function setCurrentSection(id) {
    var article = activeArticle();
    if (!article) return;
    if (activeSectionId === id) return;
    activeSectionId = id;
    article.querySelectorAll('[data-wiki-section]').forEach(function (section) {
      section.classList.toggle('is-active', section.id === id);
    });
    article.querySelectorAll('[data-wiki-section-link]').forEach(function (link) {
      var active = link.dataset.wikiSectionLink === id;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  function flashSection(section) {
    if (!section) return;
    window.clearTimeout(highlightTimer);
    section.classList.remove('is-jump-target');
    void section.offsetWidth;
    section.classList.add('is-jump-target');
    highlightTimer = window.setTimeout(function () { section.classList.remove('is-jump-target'); }, 1800);
  }

  function scrollToSection(section, updateHash) {
    if (!section) return;
    if (updateHash) window.history.pushState({}, '', '#' + section.id);
    pendingSectionId = section.id;
    var top = section.getBoundingClientRect().top + window.scrollY - 84;
    window.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setCurrentSection(section.id);
    flashSection(section);
    scheduleSectionSync();
  }

  function clearPendingSection() {
    pendingSectionId = '';
    if (pendingSectionTimer !== null) {
      window.clearTimeout(pendingSectionTimer);
      pendingSectionTimer = null;
    }
  }

  function deferPendingSectionClear() {
    if (pendingSectionTimer !== null) window.clearTimeout(pendingSectionTimer);
    pendingSectionTimer = window.setTimeout(function () {
      pendingSectionTimer = null;
      pendingSectionId = '';
      scheduleSectionSync();
    }, 700);
  }

  function sectionIndexAtAnchor(sections, anchor) {
    var index = 0;
    sections.forEach(function (section, candidateIndex) {
      if (section.getBoundingClientRect().top + window.scrollY <= anchor) index = candidateIndex;
    });
    return index;
  }

  function syncSectionFromScroll() {
    sectionFrame = null;
    var article = activeArticle();
    if (!article) return;
    var sections = Array.from(article.querySelectorAll('[data-wiki-section]'));
    if (!sections.length) return;
    var currentIndex = sections.findIndex(function (section) { return section.id === activeSectionId; });
    if (currentIndex < 0) {
      setCurrentSection(sections[0].id);
      return;
    }
    var anchor = window.scrollY + 112;
    if (pendingSectionId) {
      var pendingSection = sections.find(function (section) { return section.id === pendingSectionId; });
      if (!pendingSection) {
        clearPendingSection();
      } else {
        var pendingTop = pendingSection.getBoundingClientRect().top + window.scrollY;
        if (Math.abs(pendingTop - anchor) > 24) {
          setCurrentSection(pendingSection.id);
          deferPendingSectionClear();
          return;
        }
        clearPendingSection();
      }
    }
    var candidateIndex = sectionIndexAtAnchor(sections, anchor);
    var hysteresis = 16;
    if (candidateIndex > currentIndex) {
      var nextTop = sections[candidateIndex].getBoundingClientRect().top + window.scrollY;
      if (nextTop <= anchor - hysteresis) setCurrentSection(sections[candidateIndex].id);
    } else if (candidateIndex < currentIndex) {
      var currentTop = sections[currentIndex].getBoundingClientRect().top + window.scrollY;
      if (currentTop >= anchor + hysteresis) setCurrentSection(sections[candidateIndex].id);
    }
  }

  function scheduleSectionSync() {
    if (sectionFrame !== null) return;
    sectionFrame = window.requestAnimationFrame(syncSectionFromScroll);
  }

  function bindHighlights() {
    if (observer) observer.disconnect();
    activeSectionId = '';
    clearPendingSection();
    var article = activeArticle();
    if (!article) return;
    var sections = Array.from(article.querySelectorAll('[data-wiki-section]'));
    var links = article.querySelectorAll('[data-wiki-section-link]');
    links.forEach(function (link) {
      link.onclick = function (event) {
        var target = document.getElementById(link.dataset.wikiSectionLink);
        if (!target) return;
        event.preventDefault();
        scrollToSection(target, true);
      };
    });
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(function () { scheduleSectionSync(); }, { rootMargin: '-112px 0px -58% 0px', threshold: [0, 0.2] });
      sections.forEach(function (section) { observer.observe(section); });
    }
    var hash = window.location.hash.replace(/^#/, '');
    var hashTarget = hash ? document.getElementById(hash) : null;
    if (hashTarget && article.contains(hashTarget)) {
      window.setTimeout(function () { scrollToSection(hashTarget, false); }, 40);
    } else if (sections[0]) {
      setCurrentSection(sections[0].id);
    }
    scheduleSectionSync();
  }

  function applyLanguage() {
    var lang = currentLanguage();
    page.dataset.wikiLanguage = lang;
    var pageLang = validLanguage(page.dataset.wikiPageLang);
    if (pageLang && pageLang !== lang) {
      var languageLink = page.querySelector('[data-wiki-language="' + lang + '"]');
      if (languageLink && languageLink.href !== window.location.href) {
        window.location.replace(languageLink.href);
      }
      return;
    }
    document.documentElement.lang = lang === 'ja' ? 'ja' : 'zh-CN';
    page.querySelectorAll('[data-wiki-lang]').forEach(function (article) {
      article.hidden = pageLang ? article.dataset.wikiLang !== pageLang : article.dataset.wikiLang !== lang;
    });
    page.querySelectorAll('[data-wiki-language]').forEach(function (link) {
      var active = link.dataset.wikiLanguage === lang;
      link.classList.toggle('is-active', active);
      link.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var article = activeArticle();
    var title = article && article.querySelector('h1');
    if (title) document.title = title.textContent.trim() + ' - 同好会维基';
    applyAppearance();
    bindHighlights();
  }

  document.addEventListener('click', function (event) {
    var launcher = event.target.closest('[data-appearance-launcher]');
    if (launcher) {
      openAppearancePopover();
      return;
    }
    var hide = event.target.closest('[data-appearance-hide]');
    if (hide) {
      hideAppearanceRail();
      return;
    }
    var close = event.target.closest('[data-appearance-close]');
    if (close) {
      closeAppearancePopover();
      return;
    }
    var dock = event.target.closest('[data-appearance-dock]');
    if (dock) {
      restoreAppearanceRail();
      return;
    }
    var appearanceButton = event.target.closest('[data-appearance-key]');
    if (appearanceButton) {
      var key = appearanceButton.dataset.appearanceKey;
      if (allowed[key].indexOf(appearanceButton.dataset.appearanceValue) !== -1) {
        appearance[key] = appearanceButton.dataset.appearanceValue;
        saveAppearance();
        applyAppearance();
      }
    }
    var reset = event.target.closest('[data-appearance-reset]');
    if (reset) {
      appearance = Object.assign({}, DEFAULTS);
      saveAppearance();
      applyAppearance();
    }
    var toggle = event.target.closest('[data-appearance-toggle]');
    if (toggle) {
      var rail = toggle.closest('.wiki-appearance-rail');
      var open = rail.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '收起阅读设置' : '展开阅读设置';
    }
    if (appearancePopoverOpen && !event.target.closest('[data-wiki-appearance]')) closeAppearancePopover();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && appearancePopoverOpen) closeAppearancePopover();
  });
  window.addEventListener('scroll', scheduleSectionSync, { passive: true });
  window.addEventListener('resize', scheduleSectionSync);
  window.addEventListener('hashchange', function () { bindHighlights(); });
  window.addEventListener('popstate', applyLanguage);
  if (window.VNFLanguage) {
    window.VNFLanguage.subscribe(applyLanguage);
    window.VNFLanguage.ready.then(applyLanguage).catch(function () {});
  }
  isolateReaderFromWallpaper();
  applyLanguage();
})();
