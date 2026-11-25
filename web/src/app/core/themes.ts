// Event themes (SPEC-LITE §3). Adding an event type = one entry here.
// Text-on-bg and onPrimary-on-primary pairs are chosen to pass WCAG AA (4.5:1).

export type Splash = 'leaves' | 'confetti' | 'petals';

export interface Theme {
  primary: string;
  accent: string;
  bg: string;
  surface: string;
  text: string;
  onPrimary: string;
  font: string;
  splash: Splash;
  dark: boolean;
}

export const THEMES: Record<string, Theme> = {
  mehendi: {
    primary: '#3E7C3A', accent: '#B5532A', bg: '#F3F7EC', surface: '#FFFFFF', text: '#1C2A1B',
    onPrimary: '#FFFFFF', font: "'Yatra One', serif", splash: 'leaves', dark: false,
  },
  sangeet: {
    // White on #FF3EA5 is only ~3:1, so buttons use the dark bg colour as ink.
    primary: '#FF3EA5', accent: '#7C5CFF', bg: '#140B24', surface: '#22153A', text: '#F5EEFF',
    onPrimary: '#140B24', font: "'Unbounded', sans-serif", splash: 'confetti', dark: true,
  },
  muhurtham: {
    primary: '#9E1B1B', accent: '#D4A017', bg: '#FFF6E5', surface: '#FFFFFF', text: '#2A1408',
    onPrimary: '#FFFFFF', font: "'Cinzel', serif", splash: 'petals', dark: false,
  },
  feast: {
    primary: '#2F6B2F', accent: '#C8A24A', bg: '#F7F1DE', surface: '#FFFFFF', text: '#222A14',
    onPrimary: '#FFFFFF', font: "'Baloo Thambi 2', sans-serif", splash: 'leaves', dark: false,
  },
};

/** Neutral look for staff screens and before any event is live. */
export const DEFAULT_THEME: Theme = {
  primary: '#7A2E3B', accent: '#C8A24A', bg: '#FAF7F2', surface: '#FFFFFF', text: '#241A1C',
  onPrimary: '#FFFFFF', font: "'Cinzel', serif", splash: 'petals', dark: false,
};

export const themeFor = (type: string | null | undefined): Theme => (type && THEMES[type]) || DEFAULT_THEME;
