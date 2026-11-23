// The four layers a brief is built from, as data. Look says how the picture looks; genre says what
// the story is about; format says what kind of video it is; sound says how it is heard. They are
// chosen separately and combined on one brief - there is deliberately no dropdown of combinations.
//
// Every hint here is a description of an appearance or a shape. Nothing in this file claims that a
// generation backend can produce a look, that a format is trending, or that a film with these
// properties will perform anywhere.

export const LAYER_KEYS = ['style', 'genre', 'format', 'sound'];

export const STUDIO_SUGGESTS = 'studio_suggests';
export const OTHER = 'other';

// ---------------------------------------------------------------- LOOK
export const STYLE_GROUPS = [
  {
    group: '2D looks',
    options: [
      { value: 'anime_2d', label: '2D anime (hand-drawn look)', reference: 'Studio Ghibli films',
        hint: 'Classic Japanese animation style, drawn rather than rendered.',
        descriptors: 'soft hand-painted backgrounds, gentle everyday motion, detailed nature, warm light' },
      { value: 'cartoon_classic', label: 'Classic hand-drawn cartoon', reference: 'classic Disney shorts',
        hint: 'Western frame-by-frame cartoon look.', descriptors: 'bold ink lines, flat cel colour, squash-and-stretch motion' },
      { value: 'painterly', label: 'Painterly (hand-painted look)', reference: 'Loving Vincent, the first fully oil-painted feature',
        hint: 'Every frame looks like a painting.', descriptors: 'visible brushstrokes, impasto texture, edged colour' },
      { value: 'watercolor_ink', label: 'Watercolour / ink wash', reference: null,
        hint: 'Soft, translucent hand-painted look.', descriptors: 'wet edges, paper grain, diluted washes' },
      { value: 'flat_vector', label: 'Flat vector / cartoon', reference: 'modern explainer videos and TV cartoons',
        hint: 'Clean flat shapes and colours.', descriptors: 'untextored fills, simple geometry, crisp outlines' },
      { value: 'motion_graphics', label: 'Motion graphics / typography', reference: 'title sequences and product explainers',
        hint: 'Animated text, icons and infographics.', descriptors: 'kinetic type, iconography, diagrammatic motion' },
    ],
  },
  {
    group: '3D looks',
    options: [
      { value: 'stylized_3d', label: 'Stylized 3D (feature-animation look)', reference: null,
        hint: 'Polished, expressive 3D like modern animated feature films.',
        note: '"Pixar style" is one studio\'s look, not a category; this is the broader industry term.',
        descriptors: 'rounded forms, exaggerated proportion, clean lighting' },
      { value: 'toon_shaded_3d', label: 'Toon-shaded 3D (cel shading)', reference: null,
        hint: '3D models rendered with flat shading so they read like 2D drawings.',
        note: 'One technique in the non-photorealistic rendering family.',
        descriptors: 'cel shading, hard shadow bands, ink lines' },
      { value: 'comic_3d', label: 'Comic-book 3D', reference: 'Spider-Man: Into the Spider-Verse',
        hint: '3D pushed toward a printed-comic look with halftones and ink lines.', descriptors: 'halftone dots, screen-tone colour, ink outlines over 3D' },
      { value: 'cg_anime_3d', label: '3D CG anime', reference: 'Beastars, Land of the Lustrous',
        hint: 'Anime made with 3D computer graphics ("CG" in anime-industry usage).', descriptors: 'flat-lit 3D, anime linework reading, limited motion' },
      { value: 'live_action_realism', label: 'Live-action / cinematic realism', reference: null,
        hint: 'Looks like a normal movie filmed with a camera, not animation.',
        note: 'About the intended appearance, even if the footage is generated.',
        descriptors: 'natural lighting, real optics, shallow depth of field' },
    ],
  },
  {
    group: 'Handmade looks',
    options: [
      { value: 'stop_motion_look', label: 'Stop-motion look', reference: 'Wallace & Gromit (clay), Kubo and the Two Strings (puppet stop motion)',
        hint: 'The photographed-models look, animated frame by frame.',
        note: 'A generated video would imitate this look; no physical models are involved.',
        descriptors: 'slight frame-to-frame jitter, tactile surfaces, practical lighting' },
    ],
  },
];

// ---------------------------------------------------------------- GENRE / MOOD
export const GENRES = [
  { value: 'fantasy_mythical', label: 'fantasy / mythical', hint: 'Invented worlds, legends, creatures and quests. "Mythical" is a story category, not a way of rendering a picture.' },
  { value: 'superhero', label: 'superhero', hint: 'A genre: costumed power and consequence. It can be drawn in any look - live-action realism, anime, or comic-book 3D - so it is not itself a look.' },
  { value: 'sci_fi', label: 'sci-fi', hint: 'Futures, technology, space, and their human cost.' },
  { value: 'slice_of_life', label: 'slice of life', hint: 'Small everyday moments, no world-ending stakes.' },
  { value: 'comedy', label: 'comedy', hint: 'Built to land a joke or an absurd turn.' },
  { value: 'drama', label: 'drama', hint: 'Carried by feeling between people.' },
  { value: 'horror', label: 'horror', hint: 'Built on dread, threat and restraint. Needs the owner\'s own review before release.' },
  { value: 'adventure', label: 'adventure', hint: 'A journey, obstacles, and movement through places.' },
];

// ---------------------------------------------------------------- FORMAT
export const FORMATS = [
  { value: 'story_short_film', label: 'Story short film', hint: 'A scripted story with characters, like the studio does today.', default: true },
  { value: 'off_camera_narrated', label: 'Off-camera narrated story', hint: 'A story told by a narrator over the visuals. No host or creator appears on screen. Characters in the story may still appear, with faces, in whatever look is chosen.' },
  { value: 'off_camera_explainer', label: 'Off-camera explainer / mini-documentary', hint: 'A narrated video about a topic, shown with animation, maps, objects and imagery, no on-camera host. Works best with a real angle and real facts.' },
  { value: 'asmr_loop', label: 'ASMR / satisfying loop', hint: 'One calm action and its sound, short, often looping (slicing, pouring, brushing, rain on a window). Usually no talking.' },
  { value: 'ambient_loop', label: 'Ambient / cozy loop', hint: 'Slow, long-running visuals meant as a calm backdrop for relaxing, sleeping or focusing (a rainy window, a quiet kitchen, a night train).' },
  { value: 'with_me_companion', label: '"With me" companion', hint: 'A calm companion scene where a character keeps you company while you study or work (study with me, work with me). The character can be animated.' },
];

// ---------------------------------------------------------------- SOUND
export const SOUNDS = [
  { value: 'voiceover_narration', label: 'Voice-over narration', hint: 'A narrator speaks over the visuals.' },
  { value: 'music_ambience', label: 'Music + ambience', hint: 'Score and room/nature sound, no talking.' },
  { value: 'asmr_sound_first', label: 'ASMR sound-first', hint: 'Close, detailed everyday sounds (taps, scrapes, water, fabric) lead; no talking or only soft whispering.' },
  { value: 'character_dialogue', label: 'Character dialogue', hint: 'Characters speak to each other.' },
  { value: 'silent_captions', label: 'Silent with captions', hint: 'Text on screen only.' },
];

export const SUGGEST_OPTION = { value: STUDIO_SUGGESTS, label: 'Let the studio suggest', hint: 'The creative director recommends one for this story, with one line on why.' };
export const OTHER_OPTION = { value: OTHER, label: 'Other', hint: 'Free text, one line.' };

const styleList = () => STYLE_GROUPS.flatMap((g) => g.options.map((o) => ({ ...o, group: g.group, kind: 'style' })));
export const STYLES = styleList();

const layerTable = {
  style: () => STYLES,
  genre: () => GENRES.map((g) => ({ ...g, kind: 'genre' })),
  format: () => FORMATS.map((f) => ({ ...f, kind: 'format' })),
  sound: () => SOUNDS.map((s) => ({ ...s, kind: 'sound' })),
};

/** The shared vocabulary lookup. Views and validators read labels only through this. */
export function findOption(kind, value) {
  if (value === STUDIO_SUGGESTS) return { ...SUGGEST_OPTION, kind, group: null };
  if (value === OTHER) return { ...OTHER_OPTION, kind, group: null };
  return (layerTable[kind]?.() ?? []).find((o) => o.value === value) ?? null;
}

/** The full option list for a layer: its own vocabulary, then the two non-committal choices. */
export const optionsFor = (kind) => [...(layerTable[kind]?.() ?? []), SUGGEST_OPTION, OTHER_OPTION];

export const isValidLayerValue = (kind, value) => Boolean(findOption(kind, value));

export const STYLE_FOOTNOTE = 'Describes a look. Not made by or affiliated with any studio.';
export const HONESTY_FOOTNOTE = 'These are direction labels on the brief. Nothing here claims that a generation backend can produce this result; support is not verified.';
export const SPLIT_NOTE = 'Style is how the picture looks; genre or mood is what the story is about. Format and sound say what kind of video it is and how it sounds.';
export const COMBINED_EXAMPLE = 'Look, genre, format and sound are separate: you can pick 2D anime (hand-drawn look) + fantasy / mythical + Off-camera narrated story + Music + ambience.';
export const FACELESS_NOTE = '"Faceless" means no host or creator on camera. It does not forbid animated characters from having faces. If you want no faces at all - silhouettes, backs of heads, hands, objects and places only - say so in the idea text, the Other field or the notes.';

/** Which stage a layer feeds. The look lands on the designer, not the writer. */
export const LAYER_FEEDS = {
  style: ['concept', 'script', 'storyboard', 'assets', 'edit', 'critique'],
  genre: ['concept', 'script', 'storyboard', 'assets', 'edit', 'critique'],
  format: ['concept', 'script', 'storyboard', 'assets', 'edit', 'critique'],
  sound: ['script', 'storyboard', 'assets', 'edit', 'critique'],
};

/** Everything a stage needs to know about a layer, without editing a stage list per layer. */
export const layerLabel = (kind) => ({ style: 'Look', genre: 'Genre / mood', format: 'Format', sound: 'Sound' })[kind] ?? kind;
export const defaultLayerValues = () => ({
  style: STUDIO_SUGGESTS, genres: [], format: FORMATS.find((f) => f.default).value, sound: STUDIO_SUGGESTS,
});
