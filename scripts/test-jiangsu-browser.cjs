const { app, BrowserWindow } = require('electron');

const baseUrl = process.env.JIANGSU_BROWSER_BASE_URL || 'http://127.0.0.1:8097';
const viewportNames = process.argv.includes('--all-viewports')
  ? ['desktop', 'tablet', 'mobile']
  : [process.env.JIANGSU_BROWSER_VIEWPORT || 'desktop'];
const viewportSizes = {
  desktop: { width: 1366, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectViewport(viewportName) {
  const viewport = viewportSizes[viewportName] || viewportSizes.desktop;
  const win = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) {
      consoleErrors.push(`${message} (${sourceId}:${line})`);
    }
  });

  let loadFailure = '';
  try {
    await win.loadURL(new URL('/index.html?guest=1', baseUrl).toString(), {
      userAgent: 'VNFestJiangsuSmoke/1.0',
    });
    await sleep(1800);
  } catch (error) {
    loadFailure = error.message || String(error);
  }

  let result;
  if (!loadFailure) {
    result = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, timeout = 12000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (predicate()) return true;
            await sleep(120);
          }
          return false;
        };
        const waitForSubmap = () => waitFor(() => document.querySelectorAll('.jiangsu-city').length === 13, 8000);
        const result = {
          moduleLoaded: Boolean(window.jiangsu),
          staticCityCount: window.jiangsu?.CITIES?.length || 0,
          staticPathCount: window.jiangsu?.PATHS?.length || 0,
          cityNames: window.jiangsu?.CITIES?.map((city) => city.name) || [],
          expandButton: false,
          renderedCityCount: 0,
          renderedPathCount: 0,
          badgeCount: 0,
          cityLabelsRemoved: false,
          uniformCityFill: false,
          unselectedCityFill: '',
          selectedCityFill: '',
          selectedFillContrast: false,
          mobileBadgeCompact: false,
          badgeDiameterWithinTarget: false,
          badgeStrokeWhite: false,
          cityStrokeWhite: false,
          provinceOutlineStrokeWhite: false,
          changzhouBadgeVisible: false,
          changzhouBadgeInside: false,
          wuxiBadgeInside: false,
          wuxiBadgeSafe: false,
          hoverNoBrightness: false,
          cityStrokeWidth: '',
          suqianRendered: false,
          suqianEmpty: false,
          fixedBackButtonGone: false,
          rightReturnButton: false,
          wheelZoomChanged: false,
          dragChanged: false,
          cityClickUpdatedList: false,
          blankReturnedToProvince: false,
          backReturnedToChina: false,
          returnTransitionStarted: false,
          chinaJiangsuTooltip: '',
          countrySwitchClearedSubmap: false,
          resources: [],
        };

        const moduleReady = await waitFor(() => window.jiangsu && document.querySelector('.province#js'));
        if (!moduleReady) return result;

        const jiangsuPath = document.querySelector('.province#js');
        jiangsuPath.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(700);
        result.expandButton = Boolean(document.querySelector('.jiangsu-expand-inline'));

        const expandButton = document.querySelector('.jiangsu-expand-inline');
        if (!expandButton) return result;
        expandButton.click();
        const submapReady = await waitForSubmap();
        result.renderedCityCount = document.querySelectorAll('.jiangsu-city').length;
        result.renderedPathCount = document.querySelectorAll('.jiangsu-city-path').length;
        const cityPaths = [...document.querySelectorAll('.jiangsu-city-path')];
        const cityFills = cityPaths.map((path) => getComputedStyle(path).fill);
        result.uniformCityFill = cityFills.length === 13 && new Set(cityFills).size === 1;
        result.unselectedCityFill = cityFills[0] || '';
        result.cityLabelsRemoved = document.querySelectorAll('.jiangsu-city-label').length === 0;
        result.badgeCount = document.querySelectorAll('.jiangsu-badge-layer .jiangsu-badge').length;
        result.cityStrokeWidth = cityPaths[0] ? getComputedStyle(cityPaths[0]).strokeWidth : '';
        const firstBadgeCircle = document.querySelector('.jiangsu-badge circle');
        const previousTheme = document.documentElement.getAttribute('data-theme');
        document.documentElement.setAttribute('data-theme', 'dark');
        const badgeCircleStyle = firstBadgeCircle ? getComputedStyle(firstBadgeCircle) : null;
        const badgeDiameter = firstBadgeCircle?.getBoundingClientRect().width || 0;
        result.mobileBadgeCompact = window.innerWidth > 520
          || !firstBadgeCircle
          || badgeDiameter <= 10.5;
        result.badgeDiameterWithinTarget = !firstBadgeCircle
          || badgeDiameter <= (window.innerWidth <= 520 ? 10.5 : 16);
        result.badgeStrokeWhite = Boolean(badgeCircleStyle)
          && badgeCircleStyle.stroke === 'rgb(255, 255, 255)'
          && badgeCircleStyle.strokeOpacity === '1';
        result.cityStrokeWhite = cityPaths.length === 13 && cityPaths.every((path) => {
          const style = getComputedStyle(path);
          return style.stroke === 'rgb(255, 255, 255)' && style.strokeOpacity === '1';
        });
        const provinceOutline = document.querySelector('.jiangsu-province-outline');
        const provinceOutlineStyle = provinceOutline ? getComputedStyle(provinceOutline) : null;
        result.provinceOutlineStrokeWhite = Boolean(provinceOutlineStyle)
          && provinceOutlineStyle.stroke === 'rgb(255, 255, 255)'
          && provinceOutlineStyle.strokeOpacity === '1'
          && provinceOutlineStyle.opacity === '1';
        if (previousTheme) document.documentElement.setAttribute('data-theme', previousTheme);
        else document.documentElement.removeAttribute('data-theme');
        const badgePoint = (id) => {
          const node = document.querySelector('.jiangsu-city[data-city-id="' + id + '"]');
          const path = node?.querySelector('.jiangsu-city-path');
          const badge = document.querySelector('.jiangsu-badge-layer .jiangsu-badge[data-city-id="' + id + '"]');
          const match = badge?.getAttribute('transform')?.match(/translate\(([^,]+),([^\)]+)\)/);
          if (!path || !badge || !match) return null;
          const point = { x: Number(match[1]), y: Number(match[2]) };
          let minBoundaryDistance = Infinity;
          if (typeof path.getTotalLength === 'function' && typeof path.getPointAtLength === 'function') {
            const total = path.getTotalLength();
            for (let i = 0; i <= 600; i += 1) {
              const boundary = path.getPointAtLength(total * i / 600);
              minBoundaryDistance = Math.min(minBoundaryDistance, Math.hypot(boundary.x - point.x, boundary.y - point.y));
            }
          }
          return {
            inside: typeof path.isPointInFill === 'function' && path.isPointInFill(new DOMPoint(point.x, point.y)),
            visible: badge.getBoundingClientRect().width > 0 && Boolean(badge.querySelector('.jiangsu-city-count')?.textContent),
            minBoundaryDistance,
          };
        };
        const changzhouBadge = badgePoint('cz');
        const wuxiBadge = badgePoint('wx');
        result.changzhouBadgeVisible = Boolean(changzhouBadge?.visible);
        result.changzhouBadgeInside = Boolean(changzhouBadge?.inside);
        result.wuxiBadgeInside = Boolean(wuxiBadge?.inside);
        result.wuxiBadgeSafe = Boolean(wuxiBadge && wuxiBadge.minBoundaryDistance >= 8);
        result.hoverNoBrightness = ![...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some((rule) => String(rule.selectorText || '').includes('.jiangsu-city:hover')
              && String(rule.style?.filter || '').includes('brightness'));
          } catch (_) {
            return false;
          }
        });
        const suqian = document.querySelector('.jiangsu-city[data-city-id="sq"]');
        result.suqianRendered = Boolean(suqian);
        result.suqianEmpty = Boolean(suqian && suqian.classList.contains('empty'));
        result.fixedBackButtonGone = !document.getElementById('jiangsuBackBtn')
          && !document.querySelector('.jiangsu-back-btn');
        result.rightReturnButton = Boolean(document.querySelector('[data-action="exit-jiangsu"]'));
        if (!submapReady) return result;

        const mapSvg = document.getElementById('mapSvg');
        const zoomBefore = window.d3.zoomTransform(mapSvg);
        const wheelPoint = { clientX: Math.round(window.innerWidth / 2), clientY: Math.round(window.innerHeight / 2) };
        mapSvg.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -280,
          deltaMode: 0,
          view: window,
          clientX: wheelPoint.clientX,
          clientY: wheelPoint.clientY,
          pageX: wheelPoint.clientX,
          pageY: wheelPoint.clientY,
        }));
        await sleep(360);
        const zoomAfter = window.d3.zoomTransform(mapSvg);
        result.wheelZoomChanged = zoomAfter.k > zoomBefore.k + 0.001;

        const panBefore = window.d3.zoomTransform(mapSvg);
        const dragStart = { clientX: wheelPoint.clientX - 35, clientY: wheelPoint.clientY - 25 };
        const dragEnd = { clientX: wheelPoint.clientX + 45, clientY: wheelPoint.clientY + 35 };
        mapSvg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, ...dragStart }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, buttons: 1, ...dragEnd }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 0, ...dragEnd }));
        await sleep(260);
        const panAfter = window.d3.zoomTransform(mapSvg);
        result.dragChanged = Math.abs(panAfter.x - panBefore.x) > 0.5 || Math.abs(panAfter.y - panBefore.y) > 0.5;

        const nanjing = document.querySelector('.jiangsu-city[data-city-id="nj"]');
        nanjing?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(520);
        const selectedTitle = document.getElementById('selectedTitle')?.textContent || '';
        result.selectedCityFill = nanjing?.querySelector('.jiangsu-city-path')
          ? getComputedStyle(nanjing.querySelector('.jiangsu-city-path')).fill
          : '';
        result.selectedFillContrast = Boolean(result.selectedCityFill)
          && result.selectedCityFill !== result.unselectedCityFill;
        const nanjingName = window.jiangsu.CITIES.find((city) => city.id === 'nj')?.name || '';
        result.cityClickUpdatedList = selectedTitle.includes(nanjingName)
          && document.querySelectorAll('#groupList .group-item').length > 0;

        const backdrop = document.querySelector('.jiangsu-backdrop');
        backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(520);
        const provinceTitle = document.getElementById('selectedTitle')?.textContent || '';
        result.blankReturnedToProvince = provinceTitle.includes('江苏')
          && document.querySelectorAll('.jiangsu-city.selected').length === 0;

        const returnButton = document.querySelector('[data-action="exit-jiangsu"]');
        result.rightReturnButton = result.rightReturnButton && Boolean(returnButton);
        returnButton?.click();
        await sleep(35);
        result.returnTransitionStarted = Boolean(document.getElementById('mapSvg')?.classList.contains('map-switch-out'));
        await sleep(620);
        const chinaProvince = document.querySelector('.province#js');
        chinaProvince?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, pageX: 180, pageY: 180, clientX: 180, clientY: 180 }));
        chinaProvince?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, pageX: 180, pageY: 180, clientX: 180, clientY: 180 }));
        await sleep(120);
        result.chinaJiangsuTooltip = document.querySelector('#tooltip .tooltip-name')?.textContent || '';
        result.backReturnedToChina = document.querySelectorAll('.jiangsu-city').length === 0
          && !document.querySelector('[data-action="exit-jiangsu"]')
          && ['江苏', '江蘇'].includes(result.chinaJiangsuTooltip);

        const expandThird = document.querySelector('.jiangsu-expand-inline[data-action="expand-jiangsu"]');
        expandThird?.click();
        await waitForSubmap();
        document.querySelector('.user-nav-row [data-action="japan"]')?.click();
        await sleep(1200);
        result.countrySwitchClearedSubmap = document.querySelectorAll('.jiangsu-city').length === 0
          && !document.querySelector('[data-action="exit-jiangsu"]');

        result.resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        return result;
      })();
    `);
  } else {
    result = {};
  }

  const failedChecks = [];
  if (loadFailure) failedChecks.push(`load failed: ${loadFailure}`);
  if (result.staticCityCount !== 13) failedChecks.push(`static city count ${result.staticCityCount}`);
  if (result.staticPathCount !== 13) failedChecks.push(`static path count ${result.staticPathCount}`);
  if (!result.expandButton) failedChecks.push('province detail expand button missing');
  if (result.renderedCityCount !== 13) failedChecks.push(`rendered city count ${result.renderedCityCount}`);
  if (result.renderedPathCount !== 13) failedChecks.push(`rendered path count ${result.renderedPathCount}`);
  if (result.badgeCount !== 13) failedChecks.push(`rendered badge count ${result.badgeCount}`);
  if (!result.cityLabelsRemoved) failedChecks.push('city labels are still rendered under badges');
  if (!result.uniformCityFill) failedChecks.push('Jiangsu city fills are not uniform');
  if (!result.selectedFillContrast) failedChecks.push('selected Jiangsu city does not switch to the deep-orange fill');
  if (!result.badgeDiameterWithinTarget) failedChecks.push('Jiangsu badge circles are still larger than the compact target');
  if (!result.badgeStrokeWhite) failedChecks.push('Jiangsu badge rings are not pure white in dark mode');
  if (!result.cityStrokeWhite) failedChecks.push('Jiangsu city boundary strokes are not pure white in dark mode');
  if (!result.provinceOutlineStrokeWhite) failedChecks.push('Jiangsu province outline is not pure white and opaque in dark mode');
  if (!result.changzhouBadgeVisible || !result.changzhouBadgeInside) failedChecks.push('Changzhou badge is missing, hidden, or outside its path');
  if (!result.wuxiBadgeInside || !result.wuxiBadgeSafe) failedChecks.push('Wuxi badge is outside or too close to the path boundary');
  if (result.cityStrokeWidth !== '1.5px') failedChecks.push(`city stroke width ${result.cityStrokeWidth}`);
  if (!result.hoverNoBrightness) failedChecks.push('Jiangsu hover still applies brightness');
  if (!result.suqianRendered || !result.suqianEmpty) failedChecks.push('zero-count Suqian city missing or not empty');
  if (!result.fixedBackButtonGone) failedChecks.push('fixed Jiangsu back button still exists');
  if (!result.rightReturnButton) failedChecks.push('right-side Jiangsu return card missing');
  if (!result.wheelZoomChanged) failedChecks.push('Jiangsu wheel zoom did not change the D3 transform');
  if (!result.dragChanged) failedChecks.push('Jiangsu drag did not change the D3 transform');
  if (!result.cityClickUpdatedList) failedChecks.push('city click did not update the right-side list');
  if (!result.blankReturnedToProvince) failedChecks.push('blank-area return failed');
  if (!result.returnTransitionStarted) failedChecks.push('Jiangsu return transition did not start');
  if (!result.backReturnedToChina) failedChecks.push(`Jiangsu return failed or tooltip was not a localized Jiangsu name (got ${result.chinaJiangsuTooltip || 'empty'})`);
  if (!result.countrySwitchClearedSubmap) failedChecks.push('country switch did not clear Jiangsu subview');
  const legacyRequests = (result.resources || []).filter((url) => /jiangsu-geo\.js|geo\.datav|DataV/i.test(url));
  if (legacyRequests.length) failedChecks.push(`legacy map requests: ${legacyRequests.join(', ')}`);
  if (consoleErrors.length) failedChecks.push(`console errors: ${consoleErrors.join(' | ')}`);

  win.destroy();
  return { viewport: viewportName, failedChecks, consoleErrors, loadFailure, result };
}

app.on('window-all-closed', (event) => event.preventDefault());

app.whenReady().then(async () => {
  const results = [];
  for (const viewportName of viewportNames) {
    const result = await inspectViewport(viewportName);
    results.push(result);
    console.log(`${result.failedChecks.length ? 'FAIL' : 'OK'} ${viewportName}`, JSON.stringify(result.result));
  }
  await app.quit();
  const failures = results.filter((result) => result.failedChecks.length);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
});
