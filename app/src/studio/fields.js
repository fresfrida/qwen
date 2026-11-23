// The four layer controls, rendered once and used by both entry cards. Nothing here re-implements
// a rule: options come from lexicon.js, defaults and the summary from layers.js, so a renamed option
// cannot exist in the card but not in the stored record.
//
// The look and format fields are native <select>s inside <fieldset>s, the genre list is real
// checkboxes, and the summary is plain text produced by the same function that renders the pipeline
// view. No dropdown is rebuilt, no control lives inside another control.

import { FORMATS, GENRES, OTHER, SOUNDS, STUDIO_SUGGESTS, STYLE_GROUPS, findOption } from './lexicon.js';
import { MAX_GENRES, MAX_OTHER_CHARS, defaultFormat, defaultLayer, isLayerValue } from './layers.js';
import { escapeHtml as esc } from '../validate.js';

const OTHER_VALUE = OTHER;
const SUGGEST_VALUE = STUDIO_SUGGESTS;

/**
 * One layer select.
 *
 * `keep` is what the record actually holds. It only matters when `value` was refused: the refused
 * text is echoed in data-rejected so you can see what you sent, while the selected option stays on
 * the value still stored. Resetting the control to the documented default would read as "the brief
 * now says: let the studio suggest", which is the opposite of what happened - nothing was written.
 */
const sel = (kind, value, other, name, id, label, hint, keep) => {
  const rejected = value && !isLayerValue(kind, value) ? value : '';
  const chosen = rejected ? (keep ?? defaultLayer(kind).value) : (value ?? defaultLayer(kind).value);
  const groups = kind === 'style'
    ? STYLE_GROUPS.map((g) => `<optgroup label="${esc(g.group)}">${g.options.map((o) => option(o, chosen)).join('')}</optgroup>`).join('')
    : `<optgroup label="${esc(LABELS_FOR_GROUP[kind])}">${(kind === 'format' ? FORMATS : SOUNDS).map((o) => option(o, chosen)).join('')}</optgroup>`;
  return `<div class="field">
    <label for="${id}">${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>
    <select id="${id}" name="${name}" data-layer="${kind}" data-selected="${esc(chosen)}"${rejected ? ` data-rejected="${esc(rejected)}"` : ''}>
      ${groups}
      ${option({ value: SUGGEST_VALUE, label: 'Let the studio suggest', hint: 'The creative director picks one for this story and says why in one line.' }, chosen)}
      ${option({ value: OTHER_VALUE, label: 'Other', hint: 'Write your own in one line.' }, chosen)}
    </select>
    <input type="text" name="other${cap(kind)}" maxlength="${MAX_OTHER_CHARS}" value="${esc(other ?? '')}"
      placeholder="one line, used only when Other is chosen" data-other-for="${kind}"
      ${chosen === OTHER_VALUE ? '' : 'hidden'} aria-hidden="${chosen === OTHER_VALUE ? 'false' : 'true'}">
  </div>`;
};

const LABELS_FOR_GROUP = { format: 'Format', sound: 'Sound' };

const option = (o, chosen) =>
  `<option value="${esc(o.value)}"${o.value === chosen ? ' selected' : ''} data-hint="${esc(o.hint ?? '')}">${esc(o.label)}</option>`;

/** Genre / mood is a multi-select of checkboxes, never nested inside anything. */
function genreChips(genres = [], otherGenre) {
  const picked = new Set(genres.map((g) => g?.value).filter(Boolean));
  const boxes = GENRES.map((g) => `<label class="chip-choice">
      <input type="checkbox" name="genres" value="${esc(g.value)}" data-hint="${esc(g.hint)}"${picked.has(g.value) ? ' checked' : ''}>
      <span>${esc(g.label)}</span></label>`).join('');
  const otherChosen = picked.has(OTHER_VALUE);
  return `<fieldset class="field chip-field">
    <legend>Genre or mood <span class="hint">choose up to ${MAX_GENRES}; these describe the story, not the picture</span></legend>
    <div class="chips">${boxes}
      <label class="chip-choice">
        <input type="checkbox" name="genres" value="${OTHER_VALUE}" data-hint="one line in your own words"${otherChosen ? ' checked' : ''}>
        <span>Other</span></label>
    </div>
    <input type="text" name="otherGenre" maxlength="${MAX_OTHER_CHARS}" value="${esc(otherGenre ?? '')}"
      placeholder="one line, used only when Other is ticked" data-other-for="genre"
      ${otherChosen ? '' : 'hidden'} aria-hidden="${otherChosen ? 'false' : 'true'}">
  </fieldset>`;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * The layer block for an entry card.
 * @param {{style?:{value,other}, genres?:Array, format?:{value,other}, sound?:{value,other}}} layers
 * @param {Object<string,string>} errors  field name -> message, rendered next to the field
 */
export function layerFields(layers = {}, errors = {}, stored = {}) {
  const l = { style: layers.style, genres: layers.genres, format: layers.format, sound: layers.sound };
  const keep = (kind) => stored?.[kind]?.value;
  const err = (n) => (errors[n] ? `<p class="fielderr" role="alert">${esc(errors[n])}</p>` : '');
  return `<div class="layer-fields" data-layer-block>
  <fieldset class="layer-group">
    <legend>Look</legend>
    ${sel('style', l.style?.value, l.style?.other, 'style', 'f-style', 'Video style', 'How the picture looks - not what the story is about', keep('style'))}
    ${err('style')}${err('otherStyle')}
  </fieldset>
  ${genreChips(l.genres, typeof errors.otherGenre === 'string' ? undefined : (l.genres ?? []).find((g) => g.value === OTHER_VALUE)?.other)}
  ${err('genres')}${err('otherGenre')}
  <fieldset class="layer-group">
    <legend>Format and sound</legend>
    ${sel('format', l.format?.value, l.format?.other, 'format', 'f-format', 'Format', 'What kind of video it is, including whether anyone appears on camera', keep('format'))}
    ${err('format')}${err('otherFormat')}
    ${sel('sound', l.sound?.value, l.sound?.other, 'sound', 'f-sound', 'Sound', 'How the audio carries it - any format can pair with any sound', keep('sound'))}
    ${err('sound')}${err('otherSound')}
  </fieldset>
  <p class="layer-footnote">These are direction labels on your brief. Nothing here says a generation tool can produce a
  look, a format or a sound - that has not been verified.</p>
</div>`;
}

/**
 * The one-line summary element. The words come from layers.summaryLine, never invented here, and the
 * attributes tell studio.js what the browser is allowed to rewrite: a face clause the server already
 * decided may be carried forward, an undecided one must be replaced by an honest placeholder.
 */
export function summaryElement(initial, opts = {}) {
  return `<output class="brief-summary" data-summary${opts.face ? ` data-face="${esc(opts.face)}"` : ''}${opts.faceUnread ? ' data-face-unread' : ''}>${esc(initial)}</output>`;
}
