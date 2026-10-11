/**
 * sniper-css.js — Zero-dependency CSS extraction for website cloning.
 *
 * Designed to run inside a headless browser context (via browser_evaluate
 * from the @playwright/mcp interface) or in a Node.js context that has a
 * `window`/`document` shim (e.g. jsdom).
 *
 * All functions accept a DOM element and return structured, verifiable
 * data that a builder agent can inline into component specs without guesswork.
 */

/**
 * TreeWalker-based text extractor.
 *
 * Framer (and many rich-text editors) nest text content inside deeply
 * layered <span>, <b>, <em>, <mark> elements. Simply reading
 * `el.textContent` often includes hidden helper spans or produces
 * non-contiguous text. This walker visits only ELEMENT_NODE
 * (type 1) children that are visible and extracts text from the
 * deepest leaf nodes, de-duplicating doubled text that Framer renders
 * for responsive sizing.
 *
 * @param {Element} el - Target element (e.g. a heading, paragraph, button)
 * @returns {{ text: string, html: string, layers: Array<{selector: string, text: string}> }}
 */
export function extractTypography(el) {
  if (!el) return { text: '', html: '', layers: [] };

  const layers = [];
  const seen = new Set();
  let aggregated = '';

  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        // Skip non-text-bearing elements
        if (node.matches('script, style, svg, img, video, canvas')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
    false,
  );

  let node = walker.nextNode();
  while (node) {
    // Only capture leaf-level text elements (those with no element children
    // whose text is non-empty)
    const childElements = node.children;
    if (childElements.length === 0) {
      const txt = node.textContent.trim();
      if (txt && !seen.has(txt)) {
        seen.add(txt);
        aggregated += aggregated ? ' ' + txt : txt;
        layers.push({
          selector: node.tagName.toLowerCase() + (node.className ? '.' + node.className.replace(/\s+/g, '.') : ''),
          text: txt,
        });
      }
    }
    node = walker.nextNode();
  }

  // De-duplicate doubled Framer text nodes
  const uniqueLayers = dedupeFramerText(layers);

  return {
    text: aggregated,
    html: el.innerHTML || '',
    layers: uniqueLayers,
  };
}

/**
 * Remove duplicate consecutive text layers that Framer renders
 * (it clones text into a hidden span for baseline measurement).
 * @param {Array<{selector: string, text: string}>} layers
 */
function dedupeFramerText(layers) {
  const result = [];
  const seen = new Set();
  for (const layer of layers) {
    if (!seen.has(layer.text)) {
      seen.add(layer.text);
      result.push(layer);
    }
  }
  return result;
}

/**
 * Extract ALL box-shadow layers verbatim.
 *
 * CSS allows comma-separated multi-layer shadows:
 *   box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 6px rgba(0,0,0,.1)
 *
 * This function splits on commas (outside of rgba()/hsla() parens)
 * and returns each layer as a normalized structure.
 *
 * @param {Element} el
 * @returns {Array<{inset: boolean, offsetX: string, offsetY: string, blur: string, spread: string, color: string, raw: string}>}
 */
export function extractBoxShadow(el) {
  if (!el) return [];
  const cs = getComputedStyle(el);
  const raw = cs.boxShadow;
  if (!raw || raw === 'none') return [];

  // Split on commas that are NOT inside parentheses
  const layers = splitShadowLayers(raw);

  return layers.map((layer) => {
    const trimmed = layer.trim();
    const isInset = trimmed.toLowerCase().includes('inset');
    const withoutInset = trimmed.replace(/inset\s*$/i, '').trim();
    const tokens = withoutInset.split(/\s+/).filter(Boolean);
    let offsetX = '',
      offsetY = '',
      blur = '',
      spread = '',
      color = '';

    // Shadows are: [inset] <offX> <offY> <blur> <spread> <color>
    // blur and spread are optional; color is the last significant token
    if (tokens.length >= 2) offsetX = tokens[0];
    if (tokens.length >= 3) offsetY = tokens[1];
    if (tokens.length >= 4) blur = tokens[2];
    if (tokens.length >= 5) spread = tokens[3];
    // Color may be 1 token (hex/rgb) — last token after the 4 numeric values
    if (tokens.length >= 4) color = tokens.slice(3).join(' ');

    return {
      inset: isInset,
      offsetX,
      offsetY,
      blur,
      spread,
      color,
      raw: trimmed,
    };
  });
}

/**
 * Split a box-shadow / text-shadow value into layers,
 * respecting commas inside rgba()/hsla() function arguments.
 * @param {string} value
 */
function splitShadowLayers(value) {
  const layers = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      layers.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) layers.push(current);
  return layers;
}

/**
 * Extract background information including gradients, orbs, and glassmorphism.
 *
 * @param {Element} el
 * @returns {{ backgroundColor: string, backgroundImage: string, backgroundGradient: Array|NULL, isGlassmorphism: boolean, backdropFilter: string, layers: Array }}
 */
export function extractBackground(el) {
  if (!el) return { backgroundColor: '', backgroundImage: '', backgroundGradient: null, isGlassmorphism: false, backdropFilter: '', layers: [] };

  const cs = getComputedStyle(el);
  const backgroundColor = cs.backgroundColor || 'rgba(0, 0, 0, 0)';
  const backgroundImage = cs.backgroundImage || '';
  const backdropFilter = cs.backdropFilter || cs.webkitBackdropFilter || '';

  const gradient = parseGradients(backgroundImage);
  const isGlassmorphism =
    !!backdropFilter && backdropFilter !== 'none' && /rgba?\(/i.test(backgroundColor) && parseAlpha(backgroundColor) > 0 && parseAlpha(backgroundColor) < 0.5;

  const layers = gradient.map((g, i) => ({
    type: 'gradient',
    index: i,
    raw: g,
  }));

  if (backgroundImage && !gradient.length) {
    layers.push({ type: 'image', raw: backgroundImage });
  }

  return {
    backgroundColor,
    backgroundImage,
    backgroundGradient: gradient.length > 0 ? gradient : null,
    isGlassmorphism,
    backdropFilter,
    layers,
  };
}

/**
 * Parse a background-image value into an array of gradient strings.
 * Only returns linear-gradient, radial-gradient, conic-gradient, and repeating-* variants.
 * @param {string} backgroundImage
 */
function parseGradients(backgroundImage) {
  if (!backgroundImage || backgroundImage === 'none') return [];
  const gradientRegex =
    /(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\s*\([^)]*(?:\([^)]*\)[^)]*)*\)/gi;
  const matches = [];
  let m;
  // Use a more robust parser — iterate through the string tracking paren depth
  const re = /([a-z-]+)-gradient/gi;
  while ((m = re.exec(backgroundImage)) !== null) {
    const startIdx = m.index + m[0].length;
    const rest = backgroundImage.slice(startIdx);
    const full = extractGradientCall(backgroundImage, m.index);
    if (full) matches.push(full);
  }
  return matches;
}

/**
 * Extract a full gradient(...) call starting at `startIdx`, respecting nested parens.
 * @param {string} str
 * @param {number} startIdx
 */
function extractGradientCall(str, startIdx) {
  let depth = 0;
  let started = false;
  let result = '';
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') {
      depth++;
      started = true;
    } else if (ch === ')') {
      depth--;
    }
    result += ch;
    if (started && depth === 0) break;
  }
  return result.trim() || null;
}

/**
 * Parse the alpha channel from an rgba/rgb color string.
 * @param {string} color
 */
function parseAlpha(color) {
  const m = color.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (m && m[1] !== undefined) return parseFloat(m[1]);
  return 1;
}

/**
 * Extract animation, transition, and keyfram information.
 *
 * @param {Element} el
 * @returns {{ transitions: Array, animations: Array, keyframes: Array, timingFunction: string, duration: string }}
 */
export function extractAnimations(el) {
  if (!el) return { transitions: [], animations: [], keyframes: [], timingFunction: '', duration: '' };
  const cs = getComputedStyle(el);

  const transitions = parseTransitions(cs.transition);
  const animations = parseAnimations(cs.animation);
  const keyframes = extractKeyframes(cs.animationName);

  return {
    transitions,
    animations,
    keyframes,
    timingFunction: cs.transitionTimingFunction || cs.animationTimingFunction || '',
    duration: cs.transitionDuration || cs.animationDuration || '',
  };
}

function parseTransitions(value) {
  if (!value || value === 'none') return [];
  return value.split(',').map((t) => {
    const parts = t.trim().split(/\s+/).filter(Boolean);
    return {
      property: parts[0] || '',
      duration: parts[1] || '',
      timingFunction: parts[2] || '',
      delay: parts[3] || '',
      raw: t.trim(),
    };
  });
}

function parseAnimations(value) {
  if (!value || value === 'none') return [];
  return value.split(',').map((a) => {
    const parts = a.trim().split(/\s+/).filter(Boolean);
    return {
      name: parts[0] || '',
      duration: parts[1] || '',
      timingFunction: parts[2] || '',
      delay: parts[3] || '',
      iterationCount: parts[4] || '',
      direction: parts[5] || '',
      fillMode: parts[6] || '',
      playState: parts[7] || '',
      raw: a.trim(),
    };
  });
}

function extractKeyframes(name) {
  if (!name || name === 'none') return [];
  const sheets = document.styleSheets || [];
  const results = [];
  const names = name.split(',').map((n) => n.trim());
  for (const sheet of sheets) {
    if (!sheet.cssRules) continue;
    try {
      for (const rule of sheet.cssRules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && names.includes(rule.name)) {
          const frames = [];
          for (const f of rule.cssRules) {
            frames.push({
              keyText: f.keyText,
              style: extractRuleStyle(f.style),
            });
          }
          results.push({ name: rule.name, vendorPrefix: rule.vendorPrefix || '', frames });
        }
      }
    } catch {
      // Cross-origin stylesheet — skip
      continue;
    }
  }
  return results;
}

/**
 * Extract ALL computed styles for an element and map them to
 * Tailwind arbitrary value format where possible.
 *
 * Returns a large object suitable for inlining into a
 * component spec. Values that cannot be mapped to Tailwind
 * utilities are returned as raw CSS so the builder has the
 * exact value.
 *
 * @param {Element} el
 * @returns {Object<string, string>}
 */
export function extractComputedStyles(el) {
  if (!el) return {};
  const cs = getComputedStyle(el);
  const result = {};

  // Iterate over every computed property
  const properties = [
    // Layout
    'display', 'position', 'top', 'right', 'bottom', 'left', 'zIndex',
    'float', 'clear', 'overflow', 'overflowX', 'overflowY',
    'flexDirection', 'flexWrap', 'flexFlow', 'justifyContent', 'alignItems',
    'alignContent', 'alignSelf', 'justifySelf', 'justifyItems', 'gap', 'rowGap', 'columnGap',
    'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'gridArea',
    'width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    // Box model
    'boxSizing', 'boxShadow', 'outline', 'outlineOffset', 'border',
    'borderRadius', 'borderWidth', 'borderStyle', 'borderColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    // Typography
    'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'fontStretch',
    'fontSizeAdjust', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing', 'wordBreak',
    'wordWrap', 'overflowWrap', 'textAlign', 'textDecoration', 'textTransform',
    'textIndent', 'textRendering', 'textShadow', 'whiteSpace', 'direction', 'unicodeBidi',
    // Color
    'color', 'backgroundColor', 'backgroundImage', 'backgroundRepeat',
    'backgroundPosition', 'backgroundSize', 'backgroundClip', 'backgroundOrigin',
    // Effects
    'opacity', 'visibility', 'cursor', 'backdropFilter', 'filter',
    // Animation
    'transition', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay',
    'animation', 'animationName', 'animationDuration', 'animationTimingFunction',
    'animationDelay', 'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState',
  ];

  for (const prop of properties) {
    const value = cs.getPropertyValue('--' + prop) || cs[prop] || cs.getPropertyValue(prop);
    if (value !== '' && value !== undefined && value !== null) {
      result[prop] = value;
    }
  }

  // Custom properties
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    if (prop.startsWith('--')) {
      result[prop] = cs.getPropertyValue(prop);
    }
  }

  // Map to Tailwind arbitrary values where feasible
  result.tailwind = mapToTailwind(result);

  return result;
}

/**
 * Best-effort mapping of computed CSS values to Tailwind classes.
 * Not exhaustive — captures the most common layout, spacing, and
 * typography values used in cloned sites.
 * @param {Object} styles
 */
function mapToTailwind(styles) {
  const tw = {};

  // Spacing → Tailwind scale
  const spacingMap = {
    '0px': '0', '1px': 'px', '2px': '0.5', '4px': '1', '6px': '1.5',
    '8px': '2', '10px': '2.5', '12px': '3', '14px': '3.5', '16px': '4',
    '18px': '4.5', '20px': '5', '24px': '6', '28px': '7', '32px': '8',
    '36px': '9', '40px': '10', '44px': '11', '48px': '12', '56px': '14',
    '64px': '16', '72px': '18', '80px': '20', '96px': '24',
  };

  const spacingKeys = ['margin', 'padding', 'gap', 'width', 'height', 'minWidth', 'minHeight',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'maxWidth', 'maxHeight', 'borderRadius',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    'fontSize', 'lineHeight', 'letterSpacing', 'wordSpacing'];

  for (const key of spacingKeys) {
    if (styles[key] && spacingMap[styles[key]]) {
      tw[key] = spacingMap[styles[key]];
    } else if (styles[key] && !spacingMap[styles[key]]) {
      // Use arbitrary value format
      tw[key] = `[${styles[key]}]`;
    }
  }

  return tw;
}

/**
 * Extract computed CSS of a CSSStyleDeclaration into a plain object.
 * Used internally for keyframe frame extraction.
 * @param {CSSStyleDeclaration} style
 */
function extractRuleStyle(style) {
  const obj = {};
  if (!style || !style.length) return obj;
  for (let i = 0; i < style.length; i++) {
    obj[style[i]] = style.getPropertyValue(style[i]);
  }
  return obj;
}

// Node.js export shim — in browser context these are global
export function _nodeEnvironment() {
  return typeof window === 'undefined' || typeof document === 'undefined';
}

export default {
  extractTypography,
  extractBoxShadow,
  extractBackground,
  extractAnimations,
  extractComputedStyles,
};
