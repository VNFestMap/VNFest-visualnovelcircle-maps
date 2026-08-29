import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CITY_DEFINITIONS = [
  { id: 'nj', name: '南京', tw_name: '南京', en_name: 'Nanjing' },
  { id: 'wx', name: '无锡', tw_name: '無錫', en_name: 'Wuxi' },
  { id: 'xz', name: '徐州', tw_name: '徐州', en_name: 'Xuzhou' },
  { id: 'cz', name: '常州', tw_name: '常州', en_name: 'Changzhou' },
  { id: 'sz', name: '苏州', tw_name: '蘇州', en_name: 'Suzhou' },
  { id: 'nt', name: '南通', tw_name: '南通', en_name: 'Nantong' },
  { id: 'lyg', name: '连云港', tw_name: '連雲港', en_name: 'Lianyungang' },
  { id: 'ha', name: '淮安', tw_name: '淮安', en_name: 'Huai’an' },
  { id: 'yc', name: '盐城', tw_name: '鹽城', en_name: 'Yancheng' },
  { id: 'yz', name: '扬州', tw_name: '揚州', en_name: 'Yangzhou' },
  { id: 'zj', name: '镇江', tw_name: '鎮江', en_name: 'Zhenjiang' },
  { id: 'tz', name: '泰州', tw_name: '泰州', en_name: 'Taizhou' },
  { id: 'sq', name: '宿迁', tw_name: '宿遷', en_name: 'Suqian' },
];

// Keep the existing visual order used by the pre-development module.
const DISPLAY_ORDER = ['xz', 'lyg', 'sq', 'ha', 'yc', 'yz', 'tz', 'nj', 'zj', 'cz', 'wx', 'sz', 'nt'];

const BADGE_OFFSETS = {
  徐州: { dx: 18, dy: 8 },
  连云港: { dx: 22, dy: 13 },
  宿迁: { dx: -8, dy: 23 },
  淮安: { dx: 16, dy: -20 },
  盐城: { dx: -12, dy: -8 },
  扬州: { dx: 4, dy: 27 },
  泰州: { dx: 1, dy: 31 },
  南京: { dx: -5, dy: -6 },
  镇江: { dx: 7, dy: -7 },
  常州: { dx: -23, dy: 10 },
  无锡: { dx: -21, dy: 18 },
  苏州: { dx: -10, dy: 20 },
  南通: { dx: -1, dy: -4 },
};

const SCHOOL_CITY_RULES = [
  { city: '南京', keys: ['南京', '东南大学', '河海大学', '中国药科大学', '三江学院'] },
  { city: '无锡', keys: ['江南大学'] },
  { city: '徐州', keys: ['中国矿业大学', '江苏师范大学'] },
  { city: '常州', keys: ['常州', '江苏理工学院'] },
  { city: '苏州', keys: ['苏州', '星海实验'] },
  { city: '南通', keys: ['通理工', '南通'] },
  { city: '连云港', keys: ['海洋大学'] },
  { city: '淮安', keys: ['淮安', '淮阴'] },
  { city: '盐城', keys: ['盐城'] },
  { city: '扬州', keys: ['扬州'] },
  { city: '镇江', keys: ['镇江', '江苏大学', '江苏科技大学'] },
  { city: '泰州', keys: ['泰州'] },
  { city: '宿迁', keys: ['宿迁'] },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const getValue = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : '';
  };
  const input = getValue('--input') || process.env.JIANGSU_SVG_INPUT || '';
  const output = getValue('--output') || path.join(ROOT, 'js', 'jiangsu.js');
  if (!input) {
    throw new Error('Missing SVG input. Pass --input <江苏省.svg> or set JIANGSU_SVG_INPUT.');
  }
  return { input: path.resolve(input), output: path.resolve(output) };
}

function parseAttributes(tag) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let match;
  while ((match = pattern.exec(tag))) attrs[match[1]] = match[3];
  return attrs;
}

function readSvg(input) {
  const source = fs.readFileSync(input, 'utf8');
  const svgTag = source.match(/<svg\b[^>]*>/i)?.[0] || '';
  const svgAttrs = parseAttributes(svgTag);
  const width = Number.parseFloat(svgAttrs.width || '878');
  const height = Number.parseFloat(svgAttrs.height || '434');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('SVG width/height must be positive numbers.');
  }

  const paths = [];
  const outlinePaths = [];
  const pathPattern = /<path\b[^>]*>/gi;
  let match;
  while ((match = pathPattern.exec(source))) {
    const attrs = parseAttributes(match[0]);
    const d = String(attrs.d || '').trim();
    const fill = String(attrs.fill || '').trim().toLowerCase();
    const stroke = String(attrs.stroke || '').trim();
    if (!d) continue;
    if (fill && fill !== 'none' && fill !== 'transparent') paths.push(d);
    if (stroke && (!fill || fill === 'none' || fill === 'transparent')) outlinePaths.push(d);
  }

  if (paths.length !== CITY_DEFINITIONS.length) {
    throw new Error(`Expected ${CITY_DEFINITIONS.length} filled city paths, found ${paths.length}.`);
  }

  const cityPaths = paths.map((d, sourceIndex) => ({
    ...CITY_DEFINITIONS[sourceIndex],
    sourceIndex,
    d,
    badgeOffset: BADGE_OFFSETS[CITY_DEFINITIONS[sourceIndex].name] || { dx: 0, dy: 0 },
  }));

  return {
    viewBox: [0, 0, width, height],
    cityPaths,
    provinceOutline: outlinePaths.at(-1) || '',
    sourcePathCount: (source.match(/<path\b/gi) || []).length,
  };
}

function renderModule(data, input) {
  const cityPaths = JSON.stringify(data.cityPaths, null, 4);
  const viewBox = JSON.stringify(data.viewBox);
  const displayReferences = DISPLAY_ORDER.map((id) => {
    const sourceIndex = data.cityPaths.findIndex((city) => city.id === id);
    return `CITY_PATHS[${sourceIndex}]`;
  }).join(',\n        ');
  const badgeOffsets = JSON.stringify(BADGE_OFFSETS, null, 4);
  const rules = JSON.stringify(SCHOOL_CITY_RULES, null, 4);
  const outline = JSON.stringify(data.provinceOutline);
  const sourceName = path.basename(input).replace(/\*\//g, '* /');

  return `// jiangsu.js — 江苏地区 13 地级市子地图（由 SVG 离线转换为自包含 JS）
// Source reference: ${sourceName}
// Runtime data: inline CITY_PATHS; no SVG, GeoJSON or external map request is required.
(function (global) {
    'use strict';

    var VIEW_BOX = ${viewBox};
    var PROVINCE_OUTLINE = ${outline};
    var CITY_PATHS = ${cityPaths};
    var JIANGSU_BADGE_OFFSETS = ${badgeOffsets};

    var JIANGSU_CITIES = [
        ${displayReferences}
    ];

    var JIANGSU_SCHOOL_CITY_RULES = ${rules};
    var CITY_NAME_SET = {};
    JIANGSU_CITIES.forEach(function (city) { CITY_NAME_SET[city.name] = true; });

    function normalizeCityName(raw) {
        var value = String(raw || '').replace(/市$/, '').trim();
        return CITY_NAME_SET[value] ? value : '';
    }

    function cityNames() {
        return JIANGSU_CITIES.map(function (city) { return city.name; });
    }

    function getCityForSchool(schoolText) {
        var source = String(schoolText || '');
        if (!source) return '';
        for (var i = 0; i < JIANGSU_SCHOOL_CITY_RULES.length; i++) {
            var rule = JIANGSU_SCHOOL_CITY_RULES[i];
            for (var j = 0; j < rule.keys.length; j++) {
                if (source.indexOf(rule.keys[j]) !== -1) return rule.city;
            }
        }
        return '';
    }

    function getCityForClub(club) {
        if (!club) return '';
        var explicit = normalizeCityName(club.city);
        if (explicit) return explicit;
        return getCityForSchool(String(club.school || '') + ' ' + String(club.name || ''));
    }

    function buildGeoFeatures() {
        return JIANGSU_CITIES.map(function (city) {
            return {
                id: city.id,
                name: city.name,
                tw_name: city.tw_name,
                en_name: city.en_name,
                sourceIndex: city.sourceIndex,
                d: city.d,
                badgeOffset: city.badgeOffset || JIANGSU_BADGE_OFFSETS[city.name] || { dx: 0, dy: 0 }
            };
        });
    }

    // options: { width, height, cityCounts, cityFill, onCityClick }
    function draw(container, options) {
        options = options || {};
        if (typeof d3 === 'undefined' || !container) return null;

        var svg = d3.select(container);
        svg.html('');

        var width = options.width || container.clientWidth || 800;
        var height = options.height || container.clientHeight || 600;
        svg.attr('width', width).attr('height', height).attr('viewBox', '0 0 ' + width + ' ' + height);

        var sourceWidth = VIEW_BOX[2];
        var sourceHeight = VIEW_BOX[3];
        var zoomK = Math.max(0.1, Math.min((width * 0.78) / sourceWidth, (height * 0.82) / sourceHeight));
        var tx = (width - sourceWidth * zoomK) / 2;
        var ty = (height - sourceHeight * zoomK) / 2;
        var group = svg.append('g')
            .attr('class', 'jiangsu-submap')
            .attr('transform', 'translate(' + tx + ',' + ty + ') scale(' + zoomK + ')');

        svg.append('rect')
            .attr('class', 'jiangsu-backdrop')
            .attr('x', 0).attr('y', 0)
            .attr('width', width).attr('height', height)
            .lower();

        var counts = options.cityCounts || {};
        var cityFill = options.cityFill || 'var(--jiangsu-map-fill)';
        var onCityClick = typeof options.onCityClick === 'function' ? options.onCityClick : null;
        var features = buildGeoFeatures();
        var strokeWidth = 1.5;
        // 手机端地图区域更紧凑，徽章保持可读但减少相互遮挡。
        var isCompactViewport = width <= 520;
        var badgeRadius = (isCompactViewport ? 4.5 : 7.5) / zoomK;
        var badgeRadiusLarge = (isCompactViewport ? 5.5 : 8.5) / zoomK;
        var fontSize = (isCompactViewport ? 5.5 : 8.5) / zoomK;
        var fontSizeLarge = (isCompactViewport ? 5 : 7.5) / zoomK;
        var badgeStrokeWidth = (isCompactViewport ? 1 : 1.4) / zoomK;
        var badgeRecords = [];

        features.forEach(function (feature) {
            var count = Number(counts[feature.name] || 0);
            var node = group.append('g')
                .attr('class', 'jiangsu-city' + (count ? '' : ' empty'))
                .attr('data-city', feature.name)
                .attr('data-city-id', feature.id)
                .attr('data-source-index', feature.sourceIndex);

            var cityPath = node.append('path')
                .attr('class', 'jiangsu-city-path')
                .attr('d', feature.d)
                .attr('stroke', '#ffffff')
                .attr('stroke-opacity', 1)
                .attr('stroke-width', strokeWidth)
                .attr('shape-rendering', 'geometricPrecision')
                .attr('fill', cityFill);

            var box = { x: VIEW_BOX[2] / 2, y: VIEW_BOX[3] / 2, width: 0, height: 0 };
            try {
                if (cityPath.node() && typeof cityPath.node().getBBox === 'function') box = cityPath.node().getBBox();
            } catch (error) {}
            var offset = feature.badgeOffset || { dx: 0, dy: 0 };
            var ax = box.x + box.width / 2 + offset.dx;
            var ay = box.y + box.height / 2 + offset.dy;
            var radius = count > 99 ? badgeRadiusLarge : badgeRadius;

            badgeRecords.push({ feature: feature, count: count, ax: ax, ay: ay, radius: radius });

            if (onCityClick) {
                node.on('click', function (event) {
                    event.stopPropagation();
                    onCityClick(feature.name, node.node());
                });
            }
        });

        if (PROVINCE_OUTLINE) {
            group.append('path')
                .attr('class', 'jiangsu-province-outline')
                .attr('d', PROVINCE_OUTLINE)
                .attr('fill', 'none')
                .attr('stroke', '#ffffff')
                .attr('stroke-opacity', 1)
                .attr('opacity', 1)
                .attr('stroke-width', 1.4);
        }

        var badgeLayer = group.append('g')
            .attr('class', 'jiangsu-badge-layer');
        badgeRecords.forEach(function (record) {
            var feature = record.feature;
            var badge = badgeLayer.append('g')
                .attr('class', 'jiangsu-badge')
                .attr('data-city', feature.name)
                .attr('data-city-id', feature.id)
                .attr('transform', 'translate(' + record.ax + ',' + record.ay + ')');
            badge.append('circle')
                .attr('r', record.radius)
                .attr('fill', record.count ? 'var(--md-primary)' : 'var(--md-surface-container-high)')
                .attr('stroke', '#ffffff')
                .attr('stroke-opacity', 1)
                .attr('stroke-width', badgeStrokeWidth)
                .attr('shape-rendering', 'geometricPrecision');
            badge.append('text')
                .attr('class', 'jiangsu-city-count')
                .attr('text-anchor', 'middle')
                .attr('dy', '0.35em')
                .attr('font-size', (record.count > 99 ? fontSizeLarge : fontSize) + 'px')
                .attr('font-weight', 'bold')
                .attr('fill', record.count ? '#ffffff' : 'var(--md-on-surface-variant)')
                .text(record.count > 99 ? '99+' : String(record.count));
        });

        var fitScale = zoomK;
        var zoom = d3.zoom()
            .scaleExtent([fitScale, fitScale * 12])
            .on('zoom', function (event) {
                group.attr('transform', event.transform);
            });

        svg.call(zoom).on('dblclick.zoom', null);
        svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(fitScale));

        return {
            svg: svg,
            group: group,
            zoom: zoom,
            width: width,
            height: height,
            minScale: fitScale,
            maxScale: fitScale * 12,
            baseScale: fitScale,
            baseTranslate: [tx, ty]
        };
    }

    var jiangsu = {
        VIEW_BOX: VIEW_BOX,
        CITIES: JIANGSU_CITIES,
        PATHS: CITY_PATHS,
        cityNames: cityNames,
        getCityForSchool: getCityForSchool,
        getCityForClub: getCityForClub,
        normalizeCityName: normalizeCityName,
        buildGeoFeatures: buildGeoFeatures,
        draw: draw
    };

    global.jiangsu = jiangsu;
})(typeof globalThis !== 'undefined' ? globalThis : window);
`;
}

const { input, output } = parseArgs();
const data = readSvg(input);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, renderModule(data, input), 'utf8');
console.log(`Generated ${path.relative(ROOT, output)} from ${path.basename(input)}: ${data.cityPaths.length} cities, ${data.sourcePathCount} source paths.`);
