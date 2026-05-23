#!/usr/bin/env python3
"""
Pre-run hook: load the pan-Arab MSA writing context for the translator
and reviewers.

Produces hooks/output/brand-context.md — a single reference file that
consolidates register guidance, the full anti-slop catalog, the ARETA-based
MSA grammar checklist, semantic precision rules, terminology rules, and
quality gates.

Usage:  python3 hooks/load-brand-context.py "<domain_hint>"
Output: JSON to stdout + hooks/output/brand-context.md
"""
import sys
import json
from pathlib import Path

HOOKS_OUTPUT = Path(__file__).parent / "output"
HOOKS_OUTPUT.mkdir(exist_ok=True)

domain_hint = (sys.argv[1] if len(sys.argv) > 1 else "auto").strip().lower()

FIDELITY_DOMAINS = {"legal", "medical", "technical", "academic", "financial"}
FLOW_DOMAINS = {"marketing", "social-media", "blog", "news"}

context = r"""# Arabic Translation — Writing Context (Pan-Arab MSA)

All output must be **Modern Standard Arabic (فصحى / MSA)**, the pan-Arab
standard used in professional and journalistic Arabic across the region.

**No dialect.** No Khaleeji, Egyptian, Levantine, Maghrebi, or Iraqi
vocabulary. No UAE- or Saudi-specific markers. No regional idioms. The
target is an educated reader anywhere in the Arab world — a Cairo
lawyer, a Riyadh engineer, a Beirut academic, a Casablanca journalist
should all find the register natural.

**Grammar sections §4 and §5 apply to ALL domains. The anti-slop
catalog §3 applies to ALL domains.** Register (§1) and domain
conventions (§2) are selected based on the confirmed domain.

---

## Section 1 — Register by Domain

No brand voice overlay. The register is chosen strictly by domain.

| Confirmed domain | Register | Tone |
|---|---|---|
| legal | formal MSA, high register | precise, binding, impersonal |
| medical | formal MSA, clinical | precise, unambiguous |
| academic | formal MSA, scholarly | measured, supported, citation-aware |
| financial | formal MSA, technical | precise, quantified |
| technical | business MSA | clean, terminological |
| news | business MSA, journalistic | neutral, factual, attributive |
| marketing | business MSA, persuasive | direct, outcome-focused, still formal |
| blog | business MSA, readable | conversational within MSA, no dialect |
| social-media | business MSA, concise | short sentences, still MSA |

**Address conventions (pan-Arab neutral):**
- Prefer impersonal constructions in formal domains (legal, medical,
  academic, financial, news).
- Second-person direct address is fine in marketing / blog — use أنت/كم
  in standard MSA form, not dialect (never شو، ليش، شلون).
- Never use regionally marked greetings (مرحبا الساع، يالله، خوش).

---

## Section 2 — Domain Conventions

Fidelity dominates tone for the fidelity domains. Flow leads for the
flow domains.

### Fidelity domains (legal, medical, technical, academic, financial)

- **Legal:** High-register formal MSA. Use established legal
  terminology (الطرف الأول / الطرف الثاني، يُقرّ، يتعهد، بموجب،
  حيثما ورد، يُعتدّ بـ، يحكم). Preserve clause and section numbering
  exactly. Never soften binding verbs (يجب → قد يجب is a mistranslation).
  Preserve references to jurisdiction and governing law verbatim.
- **Medical:** Precise clinical MSA. Use WHO-aligned Arabic clinical
  terminology where it exists. Keep drug names, dosages, units, and
  trial identifiers in English with Arabic gloss on first mention.
  Never paraphrase dosing, contraindication, or adverse-event language.
- **Technical:** Business MSA with established technical terms
  (الدالة, المعامل, الاستثناء, الخادم, العميل, الواجهة). Keep code,
  commands, error strings, filenames, library/API names in English.
  Translate surrounding explanation only. Prefer a coined Arabic term
  with English gloss on first use over transliteration (نسخ احتياطي
  (backup), not بَك-أب).
- **Academic:** Formal MSA, scholarly register. Preserve citations and
  reference formatting exactly. Preserve hedging language (قد، يُحتمل،
  يُرجَّح) — scholarly tentativeness is meaning, not softness. Passive
  voice preserved where the source uses it.
- **Financial:** Precise MSA with standardised accounting and market
  terminology (الأصول، الخصوم، حقوق الملكية، التدفقات النقدية، هامش
  الربح، العائد على الاستثمار، القيمة الدفترية). Keep numbers,
  currencies, ticker symbols, and fiscal-period references verbatim.
  Never round or paraphrase figures.

### Flow domains (marketing, social-media, blog, news)

- **News:** Journalistic MSA — attribute sources (قال / أفاد /
  أوضح / أكّد / نقلاً عن); preserve titles and proper nouns; use the
  present perfect where English does (منذ، حتى الآن). Neutral tone.
- **Marketing:** Persuasive but formal MSA. Transcreate hooks and
  calls-to-action so they land in Arabic (never transliterate English
  idioms). Keep the pitch specific — no vague جودة عالية / أفضل
  الحلول without concrete claims.
- **Blog:** Conversational within MSA — short sentences, direct
  address where natural, but no dialect. First-person plural (نحن)
  only where the English source uses it.
- **Social-media:** Short, sharp MSA. No dialect, no emojis added or
  dropped, hashtags preserved.

---

## Section 3 — Anti-Slop Catalog (MANDATORY, all domains)

These are AI-generation tells in Arabic. The translator must avoid
them; each reviewer must scan for them.

### §3.1 Throat-clearing openers — cut and start with the actual point

| Arabic phrase | English tell |
|---|---|
| في عالمنا اليوم / في عصرنا الحالي | In today's world |
| في ظل التطورات المتسارعة | Amid rapid developments |
| لا يخفى على أحد أن | It's no secret that |
| مما لا شك فيه أن | There's no doubt that |
| من الجدير بالذكر أن | It's worth mentioning that |
| تجدر الإشارة إلى أن | It should be noted that |
| في هذا السياق / في هذا الإطار | In this context / framework |
| على صعيد آخر / من ناحية أخرى | On another level / on the other hand (as filler) |
| يمكن القول إن | It can be said that |
| بشكل عام / بشكل كبير / بشكل ملحوظ | In general / significantly / notably (as padding) |
| في الحقيقة / في واقع الأمر | In reality / as a matter of fact |
| كما هو معروف / من المعلوم أن | As is known / it is known that |
| لا بد من الإشارة إلى | It must be pointed out that |
| بطبيعة الحال | Naturally (softener) |
| دعونا نتفق أن | Let's agree that |
| ليس من المبالغة القول | It's not an exaggeration to say |

**Rule:** Start with the claim, data, or action. If a sentence needs
one of these to sound important, rewrite the sentence.

### §3.2 Emphasis crutches — cut and strengthen the statement

| Pattern | Why it fails |
|---|---|
| وهذا ما يجعل الأمر بالغ الأهمية | Tells importance instead of showing it |
| وهنا تكمن المفارقة | Announces the insight |
| وهذا ليس مبالغة | Defensive framing |
| النقطة الجوهرية هنا | Signposting |
| الأمر الأكثر إثارة هو | Hype before substance |
| وهذا بالضبط ما نحتاجه | Tells the reader what to think |
| دعوني أكون صريحاً | Announcing honesty |
| الحقيقة المُرّة هي | Melodramatic framing |
| وهذا يعني شيئاً واحداً | Dramatic buildup |
| السؤال الحقيقي هو | Implies prior questions were fake |

### §3.3 Jargon inflation — deflate to plain Arabic

| Inflated | Plain alternative |
|---|---|
| تحقيق التحول الرقمي الشامل | رقمنة العمليات |
| تعزيز منظومة الابتكار | تحسين طريقة العمل |
| الاستفادة من البيانات الضخمة | استخدام البيانات |
| بناء قدرات مستدامة | تدريب الفريق |
| تمكين المؤسسات من | مساعدة المؤسسات على |
| إعادة هيكلة العمليات التشغيلية | تبسيط العمليات |
| تبني نهج شمولي | النظر للصورة الكاملة |
| رفع مستوى الكفاءة التشغيلية | العمل أسرع |
| إطلاق العنان لـ | استخدام / تفعيل |
| تسخير قوة | استخدام |
| الارتقاء بتجربة | تحسين تجربة |
| استشراف المستقبل | التخطيط |
| تحقيق قفزة نوعية / نقلة نوعية | تحسين كبير / تغيير مهم |
| يلعب دورًا مهمًا في | [name the concrete role] |

### §3.4 Structural anti-patterns

**Binary contrast "ليس X بل Y":** Overused. State what it IS; skip what
it isn't. Variants to flag:
- "ليس X فحسب، بل Y أيضاً"
- "لا يتعلق الأمر بـ X، بل بـ Y"
- "المسألة ليست X، المسألة Y"

**Rhetorical question stacking:** Maximum one rhetorical question per
piece. Flag:
- "ماذا لو كان بإمكاننا...؟"
- "هل تساءلت يوماً...؟"
- "ما الذي يمنعنا من...؟"

**False agency (inanimate subjects doing human things):**

| Slop | Fix |
|---|---|
| يفرض هذا التحول على المؤسسات | المؤسسات تواجه ضرورة |
| تتيح هذه التقنية فرصة | يمكن للفِرق باستخدام هذه التقنية |
| يبرز الذكاء الاصطناعي كحل | يستخدم المهندسون الذكاء الاصطناعي لـ |
| يعيد تعريف مفهوم | غيّر طريقة تفكيرنا في |
| يقود التحول نحو | تنتقل الفِرق إلى |

**Rule:** find the human — make them the subject.

**List cadence:** Three-item lists are an AI signature. Use two, or
four+. Vary numbered lists; reserve ordinals (أولاً… ثانياً… ثالثاً)
for genuinely sequential steps.

**Paragraph openers:** Avoid starting consecutive paragraphs with:
- ومن / كما أن / بالإضافة إلى / علاوة على ذلك / من جهة أخرى
  Vary, or cut the transition entirely — let the logic connect.

### §3.5 Rhythm rules

- Mix sentence lengths: short (5–8 words), medium (12–18), long (20–30).
- Three consecutive same-length sentences = monotone. Break the pattern.
- **واو chains:** maximum two و per sentence. Replace the third و
  with a full stop.
- Use كما، بينما، لكن، غير أن، في حين for variety instead of و…و….
- Em-dash (ـ) and parenthetical inserts: max one per paragraph.
- Paragraph length: 2–3 sentences (digital), 3–4 (articles). Split
  4+-sentence paragraphs. One-sentence paragraph = powerful, but
  use sparingly.

### §3.6 Trust the reader

Cut these phrases. The reader doesn't need them.

| Phrase | Action |
|---|---|
| قد يكون من المفيد | Delete — just present |
| ربما يجدر بنا | Delete — just do it |
| يمكننا القول إن | Delete — just say it |
| في رأيي المتواضع | Delete — own the claim |
| كما ذكرنا سابقاً | Delete — the reader remembers |
| دعونا نستعرض | Delete — just present |
| من المهم أن نفهم أن | Delete — just explain |
| يجب أن نتذكر أن | Delete — just state |
| في هذا المقال سنتناول | Delete — the reader sees the article |
| كما سنرى لاحقاً | Delete — they'll see it |
| خلاصة القول | Delete or replace with the actual conclusion |
| في الختام | Delete — just close |
| دعونا نلخّص | Delete |

### §3.7 Vague declaratives — replace with specifics

| Vague | Replace with |
|---|---|
| هذا يغير كل شيء | What specifically changed, and how |
| النتائج مذهلة | The actual numbers |
| الفرص لا حصر لها | Three specific opportunities |
| المستقبل واعد | What will concretely happen |
| التأثير كبير | Quantify the impact |
| الإمكانيات هائلة | List what's actually possible |

---

## Section 4 — MSA Grammar Checklist (ARETA-based)

The taxonomy below is the ARETA / QALB academic standard for Arabic
error annotation (Belkebir & Habash, CAMeL Lab, 2021). Empirical LLM
studies (arxiv 2312.08400) show **LLM Arabic is weakest on Syntactic
and Semantic errors** — §4.2 and §4.4 get the most attention.

### §4.1 Orthographic (high-recall items)

- **OH — Hamza placement.** Initial hamza: أكثر (not اكثر); إمتحان
  → امتحان (initial hamzat-wasl, not إمتحان); أ / إ / آ distinguished
  by vowel. Medial/final: ؤ / ئ / ء per seat rules. **Common LLM
  miss:** initial إ / أ swap.
- **OT — Ta marbuta vs Ha.** مشاركة (not مشاركه); distinguish ة
  (feminine ending) from ه (pronoun). Always dot the ta marbuta in
  professional output unless context strips diacritics.
- **OA — Alif maqsura vs Ya.** على (not علي); إلى (not إلي); حتى
  (not حتي). Test: does the word's inflected form switch to alif?
  If yes → write ى at base form.
- **OW — Alif fariqa.** كتبوا (not كتبو); ذهبوا (not ذهبو). The
  silent alif after و of plural verbs is mandatory and never omitted.
- **ON — Nun vs tanwin.** شكراً (not شكرن); رجلٌ (not رجلن).
  Tanwin is a diacritic, never a nun letter.
- **OS / OG — Long vs short vowels.** أوقات (not أوقت); نقيم (not
  نقيمو — no epenthetic و).

### §4.2 Syntactic (LLM weak zone — scan every sentence)

- **XC — Case (الإعراب).** Accusative tanwin on circumstantial
  adverbs and cognate objects: رائعاً, عملياً, سريعاً, أيضاً, دوماً.
  Genitive after prepositions: إلى **المدينة** (not المدينةَ).
  Nominative on subject/predicate: **الشركةُ** رابحة. In running
  text without tashkeel, ensure the accusative alif-tanwin is
  written on indefinite adverbs (عملياً with أ).
- **XG — Gender agreement.** Adjective matches noun in gender:
  الشركة **الكبرى** (not الكبير). **Broken plurals of non-humans
  take feminine singular agreement**: الكتب **المفيدة** (not
  المفيدون); المشاكل **الجديدة** (not الجدد). This is a top-5 LLM
  Arabic error.
- **XN — Number agreement.** Dual inflection: اثنان (nom) /
  اثنين (acc/gen) — must match case. **العدد والمعدود 3–10
  inverts gender**: ثلاث **سنوات** (not ثلاثة); خمسة **رجال** (not
  خمس). The number takes the opposite gender of the counted noun.
- **XF — Definiteness.** **إضافة (genitive construction) drops ال
  from the first term**: كتابُ الطالبِ (not الكتابُ الطالبِ).
  Adjectives match definiteness of the noun: البيتُ **الكبيرُ**
  (both with ال); بيتٌ **كبيرٌ** (both indefinite).
- **XT / XM — Missing/unnecessary particle.**
  - **إذا الشرطية must be followed by a verb.** "إذا مؤسستك
    تتعامل…" → "إذا **كانت** مؤسستك تتعامل…" (insert كان/كانت
    to bridge to nominal predicate).
  - **بسبب / نتيجة + verb requires الذي/التي.** "بسبب الوكيل
    نفّذ…" → "بسبب الوكيل **الذي** نفّذ…"
  - **لم requires jussive (مجزوم).** لم **يذهبْ** (not لم ذهب,
    not لم يذهبُ).
  - **لن requires subjunctive (منصوب).** لن **يذهبَ** (not لن
    يذهبْ).
- **XO — Verbal vs nominal sentence choice.** Arabic's verbal
  sentence (verb-subject-object) often reads more natural than
  English-style SVO. If you've carried the English subject-first
  rigidly through a whole paragraph, the rhythm breaks.
- **XO — Parallel structure in lists and conditional chains.**
  All items in a list or an إذا chain must follow the same
  grammatical pattern. "إذا لم تكن بياناتك جاهزة، أو فريقك غير
  مدرّب، أو كانت…" → "إذا لم تكن بياناتك جاهزة، أو **لم يكن**
  فريقك **مدرّباً**، أو كانت…"
- **XO — ما التعجبية vs ما الاستفهامية.** For "which/what" use
  **أيّ**. "ما أكثر سير عمل تكلفةً؟" reads as exclamation; write
  "**أيّ** سير عمل هو الأكثر تكلفةً؟"
- **XO — Dangling pronoun suffix.** Every ه/ها/هم/هن pronoun must
  have an unambiguous referent. "أكثرها تكلفةً وأوضح**ه** تحديداً"
  → "**الأكثر** تكلفةً **والأوضح** تحديداً."

### §4.3 Morphological

- **MI — Word form / inflection.** مفعول (passive participle)
  ≠ فاعل (active participle); wrong form flips meaning. معروف (known)
  ≠ عارف (knower).
- **MT — Verb tense and aspect.** English perfect progressive
  doesn't map directly to Arabic. Use:
  - Habitual past → كان + مضارع ("كان يذهب")
  - Completed past → ماض
  - Ongoing → مضارع (with قد + ماض for near-past if needed)
  - Future → سوف/سـ + مضارع
  Do NOT stack "سوف" with negatives: "سوف لن" is a calque — write
  **لن** alone.

### §4.4 Semantic (LLM weak zone — scan every key term)

- **SW — Word selection / preposition.** Arabic prepositions are
  lexically tied to verbs; English analogues do not transfer:
  - بحث **عن** (not بحث **على**)
  - رغب **في** / رغب **عن** (different meanings)
  - آمن **بـ** (not آمن **على**)
  - اعتمد **على** (not اعتمد **في**)
  - أثّر **في** / أثّر **على** (both used; in formal MSA prefer في)
  - فكّر **في** (not فكّر **بـ**, which is colloquial)
- **SW — False friends / near-synonyms.**

  | Wrong | Means | Intended | Use |
  |---|---|---|---|
  | متبادلة | mutual / reciprocal | interchangeable | قابلة للتبادل |
  | البياني | graphical / chart-related | data-related | البيانات (إضافة) |
  | المؤسسي | institutional | enterprise | للمؤسسات (لام الجر) |
  | العمومي | public / general | general-purpose | العام / للاستخدام العام |
  | الفعّال | effective / active | efficient | الكفء / ذو الكفاءة |

- **SW — Tautological verb + subject (same root).** تشير إشارة
  الوكيل → use a synonym for one: يدل إعلان الوكيل / تشير الإشارة
  من الوكيل. Also: يوضح التوضيح، يُبرز الإبراز.
- **SF — Fasl wa wasl (و / ف / ثم choice).**
  - **و** — simple conjunction ("and")
  - **ف** — immediate causation or consequence ("so / and then")
  - **ثم** — delayed sequence ("then / afterwards")
  Calquing every English "and" to و flattens the logic. Pick the
  connector that carries the actual relation.
- **SO — Modifier attachment ambiguity.** "بروتوكول سياق النموذج
  المُدار MCP" — المُدار could modify النموذج or البروتوكول.
  Restructure: "بروتوكول سياق النموذج (MCP) بإدارة Google."
- **SO — Mixed time expressions.** "الـ 18 شهر القادمة" mixes
  Western numeral with Arabic definite article — write
  "الثمانية عشر شهراً القادمة" or rephrase ("العام ونصف القادم").

### §4.5 Punctuation

- **PC — Arabic marks only.** Comma ،, semicolon ؛, question mark
  ؟, exclamation ! (shared). Colon : (shared). Never use Latin
  , or ; in Arabic running text.
- **PM — Missing punctuation.** Arabic commas between coordinate
  clauses are still required; do NOT drop them just because و is
  a connector.
- **PT — Unnecessary punctuation.** No Oxford-style comma before
  the final و of a list: "التفاح، البرتقال والموز" (not
  "التفاح، البرتقال، والموز").

### §4.6 Translation-specific errors (most common English → Arabic calques)

- **"سوف لن" / "سوف لا"** → لن (one word; never combine with سوف).
- **Contractions** ("don't", "can't", "won't") must expand to
  formal negation (لا/لم/لن + full verb). No colloquial shortening
  in written MSA.
- **English passive carryover.** Arabic prefers active unless the
  agent is genuinely unknown. "It has been reported that…" →
  أفادت التقارير بأن… (active with concrete subject when possible).
- **Compound-noun calques.**
  - "senior engineer" ≠ مهندس **كبير** (reads as "big engineer")
    → مهندس أول / مهندس بدرجة أولى / مهندس بخبرة عالية
  - "enterprise AI" ≠ الذكاء الاصطناعي **المؤسسي** (institutional
    AI) → الذكاء الاصطناعي **للمؤسسات** / في قطاع المؤسسات
  - "senior management" ≠ الإدارة الكبيرة → الإدارة العليا
- **Literal idiom translation.** "Kill two birds with one stone"
  → يضرب عصفورين بحجر واحد (acceptable, Arabic has it); but
  "move the needle" / "low-hanging fruit" have no literal Arabic
  equivalent — rewrite the idea, don't transliterate.

---

## Section 5 — Terminology & Abbreviations

### §5.1 Qualify ambiguous tech terms (global find-all required)

- **وكيل / وكلاء** alone means "business agent / broker" in Arabic.
  For AI agents use **الوكيل الذكي / الوكلاء الأذكياء**, or pair
  with الذكاء الاصطناعي on first mention. Apply this rule
  **everywhere** — body, tables, headings, captions. After writing,
  run a find-all on وكيل/وكلاء/الوكيل/الوكلاء and verify every
  instance is qualified or unambiguous.
- Same rule for other polysemic terms: **الذاكرة** (memory /
  computer memory — qualify); **الشبكة** (net / network — qualify);
  **السحابة** (cloud — qualify as السحابة الحاسوبية / الحوسبة
  السحابية on first use).

### §5.2 English abbreviations — Arabic meaning + (EN) on first use

- "بروتوكول سياق النموذج (MCP)" on first mention; subsequent
  mentions may use MCP alone.
- Same for API, SDK, CI/CD, URL, HTTP, etc. — if the abbreviation
  is universally recognised in tech, Arabic gloss + (EN) first,
  EN alone thereafter.

### §5.3 Proper nouns & brand names

- Keep in English unless the brand has an official Arabic form
  (Samsung, Google, Amazon — keep Latin; Al Jazeera / الجزيرة is
  explicitly bilingual, either works).
- Do not over-arabise product names or code libraries.

### §5.4 Numbers, currencies, units

- Keep numerals as in source (Western Arabic digits 1,2,3 by
  default, unless the source uses Eastern ١،٢،٣ — match the
  source).
- Currencies and units stay as in source — never convert
  values, never change currency, never round.

---

## Section 6 — Formatting & Diacritics

- Punctuation: Arabic ، ؛ ؟ (never Latin , ; ?).
- Numerals: match the source (Western 1,2,3 default).
- Diacritics (tashkeel / حركات): use sparingly — only where
  ambiguity exists or pronunciation matters (names, technical
  terms, poetry, shadda on geminated consonants where important).
- Quotes: "..." (Latin form, commonly used) or «...» (Arabic
  form, for formal / academic work). Pick one and be consistent.
- Preserve Markdown structure from the source (headings, lists,
  code blocks, tables, links) exactly. Do NOT translate code,
  URLs, filenames, command strings, or error messages.
- RTL handling: assume the renderer handles RTL. Do not insert
  Unicode direction marks unless the source had them.

---

## Section 7 — Quality Gates

Two gates. A translation passes only if BOTH pass. The consolidator
is responsible for the final check.

### §7.1 Anti-Slop Score (5 dimensions, 1–10 each; threshold 35/50)

| Dimension | What it measures |
|---|---|
| **Directness** (المباشرة) | No throat-clearing, no hedging, point-first |
| **Rhythm** (الإيقاع) | Sentence-length variation, no واو chains, no monotone paragraphs |
| **Trust** (الثقة بالقارئ) | No hand-holding, no meta-commentary, no over-explaining |
| **Authenticity** (الأصالة) | No §3 patterns, no false agency, human subjects |
| **Density** (الكثافة) | Every sentence adds information, specifics over vague claims |

**Score guide:** 1–3 multiple violations per paragraph; 4–6 occasional
slips; 7–8 strong with only minor issues; 9–10 excellent.

**Fail condition:** total below 35/50 → translation must be revised
before the run can proceed to approval.

### §7.2 Grammar Gate (0 critical errors across §4 categories)

**Critical errors** (any single instance fails the gate):

- XC — wrong case on a content word that changes meaning
- XG — gender agreement error on any noun-adjective pair
- XN — number agreement error or العدد والمعدود gender flip missing
- XF — definiteness error in إضافة
- SW — wrong preposition or confirmed false friend (see §4.4 table)
- MT — "سوف لن" / "سوف لا" calque
- Translation-specific — senior / enterprise / institutional
  calque (see §4.6)

Non-critical grammar issues (OH, OT, OA, OW, ON, OS, OG, MI, PT, PM,
minor SO) should be flagged and fixed but do not fail the gate.

---

**Write like an Arabic-native subject-matter expert, not a
translation engine. When in doubt between fidelity and flow, let the
domain decide.**
"""

context_path = HOOKS_OUTPUT / "brand-context.md"
context_path.write_text(context, encoding="utf-8")

if domain_hint in FIDELITY_DOMAINS:
    register_hint = "fidelity domain — Section 2 fidelity rules lead"
elif domain_hint in FLOW_DOMAINS:
    register_hint = "flow domain — Section 2 flow rules lead"
else:
    register_hint = "decide after confirm-domain phase"

output = {
    "status": "completed",
    "domain_hint": domain_hint,
    "register_hint": register_hint,
    "context_path": str(context_path),
    "sections": [
        "1: Register by Domain",
        "2: Domain Conventions",
        "3: Anti-Slop Catalog (7 subsections)",
        "4: MSA Grammar Checklist (ARETA-based, 6 subsections)",
        "5: Terminology & Abbreviations",
        "6: Formatting & Diacritics",
        "7: Quality Gates (anti-slop score + grammar gate)",
    ],
}

print(json.dumps(output))
