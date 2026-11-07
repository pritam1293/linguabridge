/* Shared language catalogue.
 *
 * Kept in sync with backend/app/languages.py. Extension pages load this file
 * before their own script so the popup and the text translator use exactly the
 * same list.
 */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});

  const LANGUAGES = [
    ["en", "English"],
    ["es", "Spanish"],
    ["pt", "Portuguese"],
    ["pt-BR", "Brazilian Portuguese"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["nl", "Dutch"],
    ["ru", "Russian"],
    ["uk", "Ukrainian"],
    ["pl", "Polish"],
    ["cs", "Czech"],
    ["sk", "Slovak"],
    ["ro", "Romanian"],
    ["hu", "Hungarian"],
    ["el", "Greek"],
    ["tr", "Turkish"],
    ["ar", "Arabic"],
    ["he", "Hebrew"],
    ["fa", "Persian"],
    ["ur", "Urdu"],
    ["hi", "Hindi"],
    ["hinglish", "Hinglish"],
    ["bn", "Bengali"],
    ["ta", "Tamil"],
    ["te", "Telugu"],
    ["mr", "Marathi"],
    ["gu", "Gujarati"],
    ["pa", "Punjabi"],
    ["th", "Thai"],
    ["vi", "Vietnamese"],
    ["id", "Indonesian"],
    ["ms", "Malay"],
    ["tl", "Filipino"],
    ["zh", "Chinese (Simplified)"],
    ["zh-TW", "Chinese (Traditional)"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["sv", "Swedish"],
    ["no", "Norwegian"],
    ["da", "Danish"],
    ["fi", "Finnish"],
    ["et", "Estonian"],
    ["lv", "Latvian"],
    ["lt", "Lithuanian"],
    ["sr", "Serbian"],
    ["hr", "Croatian"],
    ["bg", "Bulgarian"],
    ["ca", "Catalan"],
    ["eu", "Basque"],
    ["gl", "Galician"],
    ["sw", "Swahili"],
    ["af", "Afrikaans"],
    ["am", "Amharic"],
    ["yo", "Yoruba"],
    ["ha", "Hausa"],
    ["zu", "Zulu"],
    ["sq", "Albanian"],
    ["mk", "Macedonian"],
    ["sl", "Slovenian"],
    ["is", "Icelandic"],
    ["ga", "Irish"],
    ["cy", "Welsh"],
    ["az", "Azerbaijani"],
    ["kk", "Kazakh"],
    ["uz", "Uzbek"],
    ["hy", "Armenian"],
    ["ka", "Georgian"],
    ["ne", "Nepali"],
    ["si", "Sinhala"],
    ["km", "Khmer"],
    ["lo", "Lao"],
    ["my", "Burmese"],
    ["mn", "Mongolian"]
  ].sort((a, b) => a[1].localeCompare(b[1], "en", { sensitivity: "base" }));

  const byCode = new Map(LANGUAGES);

  LB.languages = {
    all: LANGUAGES,
    label(code) {
      const name = byCode.get(code);
      return name ? `${name} (${code})` : String(code || "");
    }
  };
})();
