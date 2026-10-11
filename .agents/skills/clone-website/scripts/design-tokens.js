/**
 * design-tokens.js — Zero-dependency design token extraction + formatting.
 *
 * Works with data collected from `sniper-css.js` or a full-page
 * reconnaissance pass. Returns structured tokens that can be
 * converted to Tailwind CSS arbitrary values or native CSS custom properties.
 *
 * Designed to run in Node.js (no browser required after token collection)
 * or inside a headless browser context.
 */

/**
 * Walk the full page and extract all design tokens.
 * Call this from inside a browser context (after navigation).
 *
 * @param {Document} [page] - document object (defaults to global `document`)
 * @returns {{ colors: object, fonts: object, spacing: object, shadows: object, borderRadius: object, breakpoints: Array }}
 */
export function extractDesignTokens(page) {
  const doc = page || (typeof document !== 'undefined' ? document : null);
  if (!doc) return emptyTokens();

  const tokens = emptyTokens();
  const seenColors = new Set();
  const seenFonts = new Set();
  const seenSpacing = new Set();

  // 1. Extract from <style> tags and linked stylesheets
  const styleSheets = Array.from(doc.styleSheets || []);
  for (const sheet of styleSheets) {
    try {
      const rules = sheet.cssRules || sheet.rules || [];
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) {
          extractFromStyleRule(rule, tokens, seenColors, seenFonts, seenSpacing);
        } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
          // Collect animation keyframe names
        } else if (rule.type === CSSRule.MEDIA_RULE) {
          extractFromMediaRule(rule, tokens);
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          extractFromFontFace(rule, tokens);
        }
      }
    } catch {
      // Cross-origin — skip
      continue;
    }
  }

  // 2. Walk the DOM and sample computed styles from elements
  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node.matches('script, style, svg, meta, link, head')) return NodeFilter.FILTER_REJECT;
        if (!node.getClientRects().some((r) => r.width > 0 && r.height > 0)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
    false,
  );

  let node = walker.nextNode();
  let count = 0;
  while (node && count < 200) {
    extractFromElement(node, tokens, seenColors, seenFonts, seenSpacing);
    node = walker.nextNode();
    count++;
  }

  // 3. Collect :root custom properties (CSS variables)
  const root = doc.documentElement;
  const rootStyles = getComputedStyle(root);
  for (let i = 0; i < rootStyles.length; i++) {
    const prop = rootStyles[i];
    if (prop.startsWith('--')) {
      tokens.colors['--' + prop.replace('--', '')] = rootStyles.getPropertyValue(prop);
    }
  }

  // 4. Font loading
  const fontEntries = (doc.fonts && doc.fonts.entries ? Array.from(doc.fonts.entries()) : []);
  for (const entry of fontEntries) {
    if (entry.loaded) {
      tokens.fonts[entry.family] = {
        family: entry.family,
        style: entry.style,
        weight: entry.weight,
        display: entry.display || 'swap',
        url: entry.source || '',
      };
    }
  }

  // 5. Viewport breakpoints
  tokens.breakpoints = extractBreakpoints(doc);

  return tokens;
}

function emptyTokens() {
  return {
    colors: {},
    fonts: {},
    spacing: {},
    shadows: {},
    borderRadius: {},
    breakpoints: [],
  };
}

/**
 * Extract color values from a CSS rule, normalizing to hex where possible.
 */
function addColor(tokens, seen, value) {
  if (!value || value === 'transparent' || value === 'inherit' || value === 'initial') return;
  if (seen.has(value)) return;
  seen.add(value);

  const hex = rgbToHex(value);
  const key = toTokenKey(value, hex);
  tokens.colors[key] = hex || value;
}

function toTokenKey(raw, hex) {
  if (hex) return hex.replace('#', '').replace(/[^a-f0-9]/gi, '');
  return raw.replace(/[^a-z0-9]/gi, '-').slice(0, 24);
}

/**
 * Convert rgb()/rgba() to hex notation.
 * @param {string} value
 */
function rgbToHex(value) {
  const m = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) return null;
  const toHex = (n) => Math.round(Number(n)).toString(16).padStart(2, '0');
  const r = toHex(m[1]), g = toHex(m[2]), b = toHex(m[3]);
  const hex = `#${r}${g}${b}`;
  if (m[4] !== undefined && parseFloat(m[4]) < 1) {
    return hex + toHex(parseFloat(m[4]) * 255);
  }
  return hex;
}

function extractFromStyleRule(rule, tokens, seenColors, seenFonts, seenSpacing) {
  for (let i = 0; i < rule.style.length; i++) {
    const prop = rule.style[i];
    const value = rule.style.getPropertyValue(prop);

    if (['color', 'background-color', 'border-color', 'background'].includes(prop)) {
      addColor(tokens, seenColors, value);
    }

    if (['font-family'].includes(prop)) {
      const families = value.split(',').map((f) => f.trim().replace(/['"]/g, ''));
      for (const f of families) {
        if (f && !seenFonts.has(f)) {
          seenFonts.add(f);
          tokens.fonts[f] = { family: f, source: rule.selectorText || '' };
        }
      }
    }

    if (prop === 'border-radius') {
      if (!tokens.borderRadius[prop] && value) tokens.borderRadius[prop] = value;
    }

    if (prop === 'box-shadow' && value && value !== 'none') {
      if (!tokens.shadows[rule.selectorText || 'default']) {
        tokens.shadows[rule.selectorText || 'default'] = parseShadows(value);
      }
    }
  }
}

function parseShadows(value) {
  const layers = splitShadowLayers(value);
  return layers.map((layer) => layer.trim());
}

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

function extractFromMediaRule(rule, tokens) {
  // Extract min-width / max-width breakpoints
  const m = rule.conditionText.match(/min-width:\s*([\d.]+)(px|em|rem|ch)/i);
  const m2 = rule.conditionText.match(/max-width:\s*([\d.]+)(px|em|rem|ch)/i);
  if (m) tokens.breakpoints.push({ type: 'min', value: m[1], unit: m[2], query: rule.conditionText });
  if (m2) tokens.breakpoints.push({ type: 'max', value: m2[1], unit: m2[2], query: rule.conditionText });
}

function extractFromFontFace(rule, tokens) {
  const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '') || 'unknown';
  tokens.fonts[family] = {
    family,
    style: rule.style.getPropertyValue('font-style') || 'normal',
    weight: rule.style.getPropertyValue('font-weight') || '400',
    display: rule.style.getPropertyValue('font-display') || 'swap',
    url: rule.style.getPropertyValue('src'),
  };
}

function extractFromElement(el, tokens, seenColors, seenFonts, seenSpacing) {
  const cs = getComputedStyle(el);

  // Colors
  addColor(tokens, seenColors, cs.color);
  addColor(tokens, seenColors, cs.backgroundColor);
  addColor(tokens, seenColors, cs.borderColor);

  // Fonts
  const fs = cs.fontFamily;
  if (fs) {
    const families = fs.split(',').map((f) => f.trim().replace(/['"]/g, ''));
    for (const f of families) {
      if (f && !seenFonts.has(f)) {
        seenFonts.add(f);
        tokens.fonts[f] = { family: f, source: 'computed' };
      }
    }
  }

  // Typography
  if (cs.fontSize) tokens.spacing['fontSize'] = cs.fontSize;
  if (cs.lineHeight) tokens.spacing['lineHeight'] = cs.lineHeight;

  // Spacing
  const spacingProps = ['margin', 'padding', 'gap', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'];
  for (const prop of spacingProps) {
    const val = cs[prop];
    if (val && val !== 'auto' && !seenSpacing.has(val)) {
      seenSpacing.add(val);
      if (!tokens.spacing[prop]) tokens.spacing[prop] = val;
    }
  }

  // Border radius
  if (cs.borderRadius && !tokens.borderRadius['computed']) tokens.borderRadius['computed'] = cs.borderRadius;

  // Shadows
  if (cs.boxShadow && cs.boxShadow !== 'none') {
    if (!tokens.shadows['computed']) tokens.shadows['computed'] = parseShadows(cs.boxShadow);
  }
}

function extractBreakpoints(doc) {
  const breakpoints = [];
  const sheets = doc.styleSheets || [];
  for (const sheet of sheets) {
    try {
      const rules = sheet.cssRules || [];
      for (const rule of rules) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          const m = rule.conditionText.match(/(min-width|max-width):\s*([\d.]+)(px|em|rem|ch)/i);
          if (m) {
            breakpoints.push({
              type: m[1].toLowerCase(),
              value: m[2],
              unit: m[3],
              query: rule.conditionText,
            });
          }
        }
      }
    } catch {
      continue;
    }
  }
  return breakpoints;
}

/**
 * Convert extracted design tokens to Tailwind CSS arbitrary value format.
 * Produces strings usable in Tailwind v3/v4 class syntax: e.g. bg-[#09090b], text-[16px]
 *
 * @param {object} tokens - output from extractDesignTokens()
 * @returns {object} - { colors: object, fonts: object, spacing: object, shadows: object, borderRadius: object, breakpoints: string[] }
 */
export function toTailwind(tokens) {
  const tw = {
    colors: {},
    fonts: {},
    spacing: {},
    shadows: {},
    borderRadius: {},
    breakpoints: [],
  };

  for (const [key, hex] of Object.entries(tokens.colors || {})) {
    if (hex && hex.startsWith('#')) {
      tw.colors[key] = `#${hex.replace(/#/g, '')}`;
    } else {
      tw.colors[key] = hex;
    }
  }

  for (const [key, val] of Object.entries(tokens.spacing || {})) {
    tw.spacing[key] = val.includes(' ') ? `[${val}]` : val;
  }

  for (const [key, val] of Object.entries(tokens.shadows || {})) {
    tw.shadows[key] = val;
  }

  for (const [key, val] of Object.entries(tokens.borderRadius || {})) {
    tw.borderRadius[key] = val.includes(' ') ? `[${val}]` : val;
  }

  for (const [family, info] of Object.entries(tokens.fonts || {})) {
    tw.fonts[family] = info;
  }

  for (const bp of tokens.breakpoints || []) {
    tw.breakpoints.push(bp.query);
  }

  return tw;
}

/**
 * Convert extracted design tokens to CSS custom properties (--token-name).
 *
 * @param {object} tokens - output from extractDesignTokens()
 * @returns {string} - CSS custom property block suitable for injection into globals.css
 */
export function toCSSTokens(tokens) {
  const lines = [':root {'];

  let colorIdx = 0;
  for (const [key, hex] of Object.entries(tokens.colors || {})) {
    const name = key.length <= 16 ? key : `color-${colorIdx++}`;
    lines.push(`  --${name}: ${hex};`);
  }

  let fontIdx = 0;
  for (const [family, info] of Object.entries(tokens.fonts || {})) {
    const varName = `font-${fontIdx++}`;
    lines.push(`  --${varName}: '${family}', ${info.fallback || 'sans-serif'};`);
    if (info.url) lines.push(`  /* @font-face url: ${info.url} */`);
  }

  for (const [key, val] of Object.entries(tokens.spacing || {})) {
    lines.push(`  --${key}: ${val};`);
  }

  for (const [key, val] of Object.entries(tokens.borderRadius || {})) {
    lines.push(`  --radius-${key}: ${val};`);
  }

  for (const [key, shadows] of Object.entries(tokens.shadows || {})) {
    const shadowStr = Array.isArray(shadows) ? shadows.join(', ') : shadows;
    lines.push(`  --shadow-${key}: ${shadowStr};`);
  }

  lines.push('}');
  return lines.join('\n');
}

export default {
  extractDesignTokens,
  toTailwind,
  toCSSTokens,
};
