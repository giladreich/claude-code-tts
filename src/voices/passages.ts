/**
 * Reading passages for voice cloning and designing, one per language.
 *
 * The passage is what the model hears (a recording of you reading it) or
 * renders (a designed voice), and its text is stored as the profile's
 * reference transcript. It therefore has to be in the language the voice is
 * meant to speak: a German voice built from an English passage speaks German
 * with an English accent, which is exactly what it sounds like.
 *
 * Each is about ten seconds at a natural pace and phonetically varied.
 */
export const PASSAGES: Record<string, string> = {
  en: "Here is a quick note before we begin. I build software most days, reading pull requests and shipping small fixes. When something breaks, I look for the root cause instead of guessing.",
  de: "Hier ist eine kurze Notiz, bevor wir beginnen. Ich schreibe fast jeden Tag Software, lese Änderungen und behebe kleine Fehler. Wenn etwas kaputtgeht, suche ich die Ursache, statt zu raten.",
  fr: "Voici une courte note avant de commencer. J'écris du logiciel presque tous les jours, je relis des modifications et je corrige de petites erreurs. Quand quelque chose casse, je cherche la cause au lieu de deviner.",
  es: "Aquí hay una nota breve antes de empezar. Escribo software casi todos los días, reviso cambios y arreglo errores pequeños. Cuando algo falla, busco la causa en lugar de adivinar.",
  it: "Ecco una breve nota prima di iniziare. Scrivo software quasi ogni giorno, rivedo le modifiche e correggo piccoli errori. Quando qualcosa si rompe, cerco la causa invece di indovinare.",
  pt: "Aqui está uma nota rápida antes de começarmos. Escrevo software quase todos os dias, reviso alterações e corrijo pequenos erros. Quando algo quebra, procuro a causa em vez de adivinhar.",
  nl: "Hier is een korte notitie voordat we beginnen. Ik schrijf bijna elke dag software, lees wijzigingen en los kleine fouten op. Als er iets stukgaat, zoek ik de oorzaak in plaats van te gokken.",
  ja: "始める前に短いメモです。私はほぼ毎日ソフトウェアを書き、変更を読み、小さな不具合を直します。何かが壊れたときは、推測せずに原因を探します。",
  zh: "开始之前先说一段简短的说明。我几乎每天都在写软件，阅读修改，并修复小的错误。出问题的时候，我会寻找根本原因，而不是猜测。",
  ko: "시작하기 전에 짧은 메모입니다. 저는 거의 매일 소프트웨어를 작성하고 변경 사항을 읽고 작은 오류를 고칩니다. 문제가 생기면 추측하지 않고 원인을 찾습니다.",
  // Vowel marks are written into this one, and checked by a test. It is
  // read by a model that guesses them otherwise, and the passage is the
  // reference the voice is built from: guessed vowels here are stored as
  // the voice itself. Written out rather than left to the diacritizer so
  // that a voice designed before that package is installed is still
  // correct, and so that a person reading it aloud reads what the voice
  // will say.
  he: "הִנֵּה הֶעָרָה קְצָרָה לִפְנֵי שֶׁנַּתְחִיל. אֲנִי כּוֹתֵב תּוֹכְנָה כִּמְעַט כָּל יוֹם, קוֹרֵא שִׁינּוּיִים וּמְתַקֵּן שְׁגִיאוֹת קְטַנּוֹת. כְּשֶׁמַּשֶּׁהוּ נִשְׁבַּר, אֲנִי מְחַפֵּשׂ אֶת הַסִּיבָּה בִּמְקוֹם לְנַחֵשׁ.",
  ar: "هذه ملاحظة قصيرة قبل أن نبدأ. أكتب البرمجيات معظم الأيام، وأقرأ التغييرات وأصلح الأخطاء الصغيرة. عندما يتعطل شيء ما، أبحث عن السبب بدلاً من التخمين.",
  ru: "Небольшая заметка перед началом. Я пишу программы почти каждый день, читаю изменения и исправляю мелкие ошибки. Когда что-то ломается, я ищу причину, а не гадаю.",
  // Languages only Chatterbox speaks, written and reviewed by native
  // speakers of each. Without them passageFor() fell back to English, so
  // designing a Turkish voice recorded English speech under a Turkish tag.
  tr: "Başlamadan önce kısa bir not düşeyim. Çoğu gün yazılım geliştiriyorum, gelen değişiklikleri okuyup küçük hataları düzeltiyorum. Bir şey bozulduğunda tahmin yürütmek yerine asıl nedeni arıyorum.",
  el: "Μια σύντομη σημείωση πριν ξεκινήσουμε. Γράφω λογισμικό σχεδόν κάθε μέρα, διαβάζω τις αλλαγές των συναδέλφων και διορθώνω μικρά λάθη. Όταν κάτι χαλάει, ψάχνω την πραγματική αιτία αντί να μαντεύω.",
  pl: "Zanim zaczniemy, krótka uwaga. Prawie codziennie piszę oprogramowanie, przeglądam cudze zmiany i poprawiam drobne błędy. Kiedy coś się psuje, spokojnie szukam źródła problemu, zamiast zgadywać.",
  sv: "Här kommer en kort kommentar innan vi börjar. Jag utvecklar mjukvara nästan varje dag, granskar andras ändringar och skickar in små rättningar. När något går sönder, letar jag efter grundorsaken istället för att gissa.",
  da: "Her er lige en hurtig bemærkning, før vi går i gang. Jeg programmerer næsten hver dag, læser andres kode og retter små fejl. Når noget går i stykker, leder jeg efter årsagen i stedet for at gætte.",
  fi: "Vielä lyhyt huomio ennen kuin aloitetaan. Teen työkseni ohjelmistoja, luen koodimuutoksia ja korjaan pieniä vikoja. Kun jokin menee rikki, en jää arvailemaan, vaan etsin perimmäisen syyn.",
  no: "Først en kjapp beskjed før vi begynner. Jeg lager programvare nesten hver dag. Jeg sjekker kodeendringer fra andre og retter små feil. Når noe ryker, leter jeg etter årsaken i stedet for å gjette.",
  hi: "शुरू करने से पहले एक छोटी सी बात। मैं लगभग रोज़ सॉफ़्टवेयर बनाता हूँ, साथियों के बदलाव देखता हूँ और मामूली गड़बड़ियाँ ठीक करता हूँ। कुछ बिगड़े तो अंदाज़ा लगाने के बजाय जड़ तक पहुँचता हूँ।",
  ms: "Sebelum kita mula, ada catatan ringkas. Hampir setiap hari saya membangunkan perisian, menyemak kod dan membetulkan ralat kecil. Apabila ada yang rosak, saya cari puncanya, bukannya meneka.",
  sw: "Kabla hatujaanza, niseme machache. Karibu kila siku ninaandika programu, ninasoma mabadiliko ya wenzangu na kurekebisha makosa madogo. Kitu kikiharibika, ninatafuta chanzo chake badala ya kubahatisha.",
};

/** The passage for a language, falling back to English. */
export function passageFor(language: string | undefined): string {
  return PASSAGES[language ?? "en"] ?? PASSAGES.en;
}

/** Languages a voice can be recorded or designed in here. */
export const PASSAGE_LANGUAGES = Object.keys(PASSAGES);
