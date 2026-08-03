/**
 * Pluggable Tokenizer — multilingual tokenization for BM25 search.
 *
 * Supports multiple tokenization strategies:
 * - jieba: Chinese word segmentation (via @node-rs/jieba)
 * - intl: Universal segmentation (via Intl.Segmenter — CJK, Latin, Cyrillic, etc.)
 * - regex: Unicode regex fallback (always available)
 *
 * Auto-detects language from Unicode character ranges and selects the best tokenizer.
 * Configuration (tdai-gateway.yaml):
 * ```yaml
 * memory:
 *   bm25:
 *     enabled: true
 *     language: "auto"  # auto | zh | en | ru | universal
 * ```
 */

const TAG = "[tokenizer]";

// ── Stop words ──

const EN_STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "up",
  "it", "its", "he", "she", "they", "them", "we", "you", "i", "me",
  "my", "your", "his", "her", "their", "our", "this", "that", "these",
  "those", "what", "which", "who", "whom",
]);

const RU_STOP_WORDS = new Set([
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как",
  "а", "то", "все", "она", "так", "его", "но", "да", "ты", "к", "у",
  "же", "вы", "за", "бы", "по", "только", "её", "мне", "было", "вот",
  "от", "меня", "ещё", "нет", "о", "из", "ему", "теперь", "когда",
  "даже", "ну", "вдруг", "ли", "если", "уже", "или", "ни", "быть",
  "был", "него", "до", "вас", "нибудь", "опять", "уж", "вам", "ведь",
  "там", "потом", "себя", "ничего", "ей", "может", "они", "тут",
  "где", "есть", "надо", "ней", "для", "мы", "тебя", "их", "чем",
  "была", "сам", "чтоб", "без", "будто", "чего", "раз", "тоже",
  "себе", "под", "будет", "ж", "тогда", "кто", "этот", "того",
  "потому", "этого", "какой", "совсем", "ним", "здесь", "этом",
  "один", "почти", "мой", "тем", "чтобы", "нее", "сейчас", "были",
  "куда", "зачем", "всех", "никогда", "можно", "при", "наконец",
  "два", "об", "другой", "хоть", "после", "над", "больше", "тот",
  "через", "эти", "нас", "про", "всего", "них", "какая", "много",
  "разве", "три", "эту", "моя", "впрочем", "хорошо", "свою", "этой",
  "перед", "иногда", "лучше", "чуть", "том", "нельзя", "такой",
  "им", "более", "всегда", "конечно", "всю", "между",
]);

const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
  "们", "那", "里", "为", "什么", "怎么", "哪", "谁", "吗", "呢",
  "吧", "啊", "呀", "哦", "嗯", "把", "被", "从", "对", "向",
  "与", "给", "让", "比", "但", "而", "或", "如果", "因为", "所以",
  "虽然", "但是", "可以", "这个", "那个", "这些", "那些", "怎样",
  "如何", "什么", "为什么", "哪里", "哪个", "多少", "几",
]);

// ── Language detection ──

export type DetectedLanguage = "zh" | "en" | "ru" | "mixed";

/**
 * Detect dominant language from text using Unicode character ranges.
 */
export function detectLanguage(text: string): DetectedLanguage {
  let zhCount = 0;
  let cyrillicCount = 0;
  let latinCount = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    // CJK Unified Ideographs
    if (code >= 0x4e00 && code <= 0x9fff) {
      zhCount++;
    }
    // Cyrillic
    else if (code >= 0x0400 && code <= 0x04ff) {
      cyrillicCount++;
    }
    // Latin
    else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      latinCount++;
    }
  }

  const total = zhCount + cyrillicCount + latinCount;
  if (total === 0) return "en"; // default

  const zhRatio = zhCount / total;
  const ruRatio = cyrillicCount / total;

  if (zhRatio > 0.3) return "zh";
  if (ruRatio > 0.3) return "ru";
  if (zhRatio > 0.1 || ruRatio > 0.1) return "mixed";
  return "en";
}

// ── Tokenizer interface ──

export interface Tokenizer {
  /** Tokenize text into words/phrases */
  tokenize(text: string): string[];
  /** Remove stop words from token list */
  removeStopWords(tokens: string[]): string[];
}

// ── Regex tokenizer (always available) ──

class RegexTokenizer implements Tokenizer {
  tokenize(text: string): string[] {
    return (
      text
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? []
    );
  }

  removeStopWords(tokens: string[]): string[] {
    // Regex tokenizer doesn't know the language, so don't filter stop words
    return tokens;
  }
}

// ── Intl.Segmenter tokenizer (universal) ──

class IntlTokenizer implements Tokenizer {
  private segmenter: Intl.Segmenter;
  private stopWords: Set<string>;

  constructor(locale: string, stopWords?: Set<string>) {
    this.segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    this.stopWords = stopWords ?? new Set();
  }

  tokenize(text: string): string[] {
    const tokens: string[] = [];
    for (const segment of this.segmenter.segment(text)) {
      if (segment.isWordLike) {
        const token = segment.segment.trim().toLowerCase();
        if (token && /[\p{L}\p{N}]/u.test(token)) {
          tokens.push(token);
        }
      }
    }
    return tokens;
  }

  removeStopWords(tokens: string[]): string[] {
    if (this.stopWords.size === 0) return tokens;
    return tokens.filter((t) => !this.stopWords.has(t));
  }
}

// ── Jieba tokenizer (Chinese) ──

class JiebaTokenizer implements Tokenizer {
  private jieba: { cutForSearch: (text: string, hmm: boolean) => string[] };

  constructor(jieba: { cutForSearch: (text: string, hmm: boolean) => string[] }) {
    this.jieba = jieba;
  }

  tokenize(text: string): string[] {
    return this.jieba
      .cutForSearch(text, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        return true;
      });
  }

  removeStopWords(tokens: string[]): string[] {
    return tokens.filter((t) => !ZH_STOP_WORDS.has(t));
  }
}

// ── Factory ──

export type TokenizerLanguage = "auto" | "zh" | "en" | "ru" | "universal";

/**
 * Create a tokenizer based on language configuration.
 *
 * @param language - Language hint: "auto" detects from text, specific language uses that tokenizer
 * @returns Tokenizer instance
 */
export function createTokenizer(language: TokenizerLanguage = "auto"): Tokenizer {
  // Try to load jieba for Chinese
  let jieba: { cutForSearch: (text: string, hmm: boolean) => string[] } | null = null;
  try {
    // Dynamic import — @node-rs/jieba is optional
    const jiebaModule = require("@node-rs/jieba");
    const { Jieba } = jiebaModule;
    const { dict } = require("@node-rs/jieba/dict");
    jieba = Jieba.withDict(dict);
  } catch {
    // jieba not available
  }

  if (language === "zh" || language === "auto") {
    if (jieba) {
      return new JiebaTokenizer(jieba);
    }
  }

  if (language === "en") {
    return new IntlTokenizer("en", EN_STOP_WORDS);
  }

  if (language === "ru") {
    return new IntlTokenizer("ru", RU_STOP_WORDS);
  }

  if (language === "universal") {
    return new IntlTokenizer("en", new Set([...EN_STOP_WORDS, ...RU_STOP_WORDS, ...ZH_STOP_WORDS]));
  }

  // Auto: detect language per-call
  if (language === "auto") {
    return new AutoDetectTokenizer(jieba);
  }

  // Fallback
  return new RegexTokenizer();
}

/**
 * Auto-detect tokenizer that selects the best strategy per text.
 */
class AutoDetectTokenizer implements Tokenizer {
  private jieba: JiebaTokenizer | null;
  private intlEn: IntlTokenizer;
  private intlRu: IntlTokenizer;
  private regex: RegexTokenizer;

  constructor(jieba: { cutForSearch: (text: string, hmm: boolean) => string[] } | null) {
    this.jieba = jieba ? new JiebaTokenizer(jieba) : null;
    this.intlEn = new IntlTokenizer("en", EN_STOP_WORDS);
    this.intlRu = new IntlTokenizer("ru", RU_STOP_WORDS);
    this.regex = new RegexTokenizer();
  }

  tokenize(text: string): string[] {
    const lang = detectLanguage(text);
    switch (lang) {
      case "zh":
        return this.jieba ? this.jieba.tokenize(text) : this.intlEn.tokenize(text);
      case "ru":
        return this.intlRu.tokenize(text);
      case "mixed":
        // For mixed text, use Intl with English locale (works for most scripts)
        return this.intlEn.tokenize(text);
      default:
        return this.intlEn.tokenize(text);
    }
  }

  removeStopWords(tokens: string[]): string[] {
    // Can't know the language from tokens alone, so don't filter
    // (stop words were already removed during tokenization if language was detected)
    return tokens;
  }
}

// ── Legacy compatibility ──

/**
 * Build an FTS5 MATCH query from raw text (replaces buildFtsQuery in sqlite.ts).
 *
 * Uses the pluggable tokenizer system for multilingual support.
 */
export function buildFtsQueryMultilingual(raw: string, language: TokenizerLanguage = "auto"): string | null {
  const tokenizer = createTokenizer(language);
  let tokens = tokenizer.tokenize(raw);
  tokens = tokenizer.removeStopWords(tokens);

  // Deduplicate
  tokens = [...new Set(tokens)];

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (replaces tokenizeForFts in sqlite.ts).
 */
export function tokenizeForFtsMultilingual(raw: string, language: TokenizerLanguage = "auto"): string {
  const tokenizer = createTokenizer(language);
  const tokens = tokenizer.tokenize(raw);
  return tokens.join(" ");
}
