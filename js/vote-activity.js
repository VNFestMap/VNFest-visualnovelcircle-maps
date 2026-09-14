(function () {
  'use strict';

  var currentScript = document.currentScript;
  var siteRoot = currentScript ? new URL('../', currentScript.src) : new URL('./', window.location.href);
  var cachedFallback = null;

  function resolveSiteUrl(value) {
    if (!value) return '';
    try {
      return new URL(value, siteRoot).toString();
    } catch (error) {
      return '';
    }
  }

  function resolveMediaUrl(value) {
    if (!value) return '';
    var normalized = String(value).trim().replace(/\\\//g, '/');
    var protocol = normalized.match(/^\/*(https?)(?:\\+)?:(.*)$/i);
    if (protocol) normalized = protocol[1].toLowerCase() + '://' + protocol[2].replace(/^[\\/]+/, '');
    try {
      if (/^(https?:)?\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
        return new URL(normalized, window.location.href).toString();
      }
      if (/^(\.\.?\/|\/)/.test(normalized)) {
        return new URL(normalized, window.location.href).toString();
      }
      return new URL(normalized, siteRoot).toString();
    } catch (error) {
      return resolveSiteUrl(normalized);
    }
  }

  function setWallpaper(url, opacity) {
    var imageValue = url ? 'url(' + JSON.stringify(url) + ')' : 'none';
    var resolvedOpacity = url ? String(opacity || 0.34) : '0.20';
    document.documentElement.style.setProperty('--activity-wallpaper-image', imageValue);
    document.documentElement.style.setProperty('--activity-wallpaper-opacity', resolvedOpacity);
    document.documentElement.style.setProperty('--wallpaper-image', imageValue);
    document.documentElement.style.setProperty('--wallpaper-opacity', resolvedOpacity);
  }

  function readContestWallpaper(contest) {
    if (!contest) return '';
    return contest.cover_url || contest.cover || contest.image_url || contest.wallpaper_url || '';
  }

  async function loadFallbackWallpaper() {
    if (cachedFallback !== null) return cachedFallback;
    if (window.__activityThemeFallbackPromise) {
      cachedFallback = await window.__activityThemeFallbackPromise;
      return cachedFallback;
    }
    cachedFallback = '';
    window.__activityThemeFallbackPromise = (async function () {
      try {
      var response = await fetch(resolveSiteUrl('api/backgrounds.php'), { credentials: 'same-origin' });
      var data = await response.json();
      var first = data && data.success && Array.isArray(data.images) ? data.images.find(function (item) {
        return item && item.url;
      }) : null;
        return first ? resolveSiteUrl(first.url) : '';
      } catch (error) {
        return '';
      }
    })();
    cachedFallback = await window.__activityThemeFallbackPromise;
    return cachedFallback;
  }

  async function applyFallbackWallpaper(opacity) {
    var url = await loadFallbackWallpaper();
    setWallpaper(url, opacity || 0.28);
    return url;
  }

  async function applyContestWallpaper(contest, opacity) {
    var direct = resolveMediaUrl(readContestWallpaper(contest));
    if (direct) {
      setWallpaper(direct, opacity || 0.36);
      return direct;
    }
    return applyFallbackWallpaper(opacity || 0.28);
  }

  window.ActivityTheme = {
    resolveSiteUrl: resolveSiteUrl,
    resolveMediaUrl: resolveMediaUrl,
    setWallpaper: setWallpaper,
    applyFallbackWallpaper: applyFallbackWallpaper,
    applyContestWallpaper: applyContestWallpaper
  };

  // 尊重用户主题偏好（由 theme-runtime 管理），不再强制亮色
  applyFallbackWallpaper();
})();
