export const LANG = {
  en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian', sv: 'Swedish', tr: 'Turkish',
  ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
};
export const langName = (code) => LANG[code] || code || '';
