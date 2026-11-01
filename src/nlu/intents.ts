import type { ItemType } from "../domain/types.js";

/** Intent classification for the rule-based engine. Patterns run on lowercase text with ё→е. */
export type Intent =
  | "cancel"
  | "help"
  | "greeting"
  | "thanks"
  | "undo"
  | "complete"
  | "delete"
  | "update"
  | "search"
  | "list"
  | "create"
  | "unknown";

export function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

const L = "(?<![\\p{L}\\d])";
const R = "(?![\\p{L}\\d])";
const re = (src: string) => new RegExp(src, "iu");

const CANCEL = re(`^(?:нет,?\\s*)?(?:отмена|отбой|не надо|не нужно|забудь(?: об этом)?|стоп|ничего|неважно|проехали|никак)[.!]*$`);
const HELP = re(`(?:что ты умеешь|что умеешь|помощь|помоги|справка|как (?:тобой|этим) пользоваться|^help$|какие команды)`);
const GREETING = re(`^(?:привет|здравствуй\\p{L}*|добрый (?:день|вечер)|доброе утро|хай|hello|hi)[!.,\\s]*$`);
const THANKS = re(`^(?:спасибо|благодарю|спс|отлично|супер|класс)[!.,\\s\\p{L}]{0,20}$`);
const UNDO = re(`^(?:верни|восстанови|отмени удаление|верни (?:как было|обратно|назад)|не удаляй)`);

const COMPLETE = re(
  `(?:${L}(?:отметь|пометь|отмечай|помечай|поставь|сделай)\\p{L}*.*(?:выполнен|сделан|готов|завершен)|${L}(?:выполнил|выполнила|сделал|сделала|закончил|закончила|завершил|завершила|сделано|выполнено|готово)${R}|${L}(?:закрой|заверши)\\s+(?:задач|напомин))`,
);
const DELETE = re(`${L}(?:удали|удалить|удаляй|убери|сотри|отмени|отменить|отменяй)\\p{L}*`);
const UPDATE = re(`${L}(?:перенеси|перенести|перенос|передвинь|сдвинь|подвинь|измени|изменить|поменяй|переименуй|переназначь|исправь|сделай\\s+(?:ее|его)\\s+на)\\p{L}*`);
const SEARCH = re(
  `(?:^когда(?![\\p{L}-])|${L}что (?:я )?(?:планировал|планировала|ставил|ставила|записывал|записывала|намечал|намечала)\\p{L}* (?:про|о|об|по|насчет)|${L}(?:найди|найти|поищи|ищи|отыщи|разыщи)|${L}когда\\s+(?:у меня\\s+)?(?:был|была|было|были|будет|будут|назначен\\p{L}*|стоит|запланирован\\p{L}*)|(?:когда-то|когда то|как-то|однажды)\\s+(?:ставил|ставила|создавал|создавала|записывал|записывала|добавлял|добавляла)|${L}есть ли (?:у меня )?(?:задача|встреча|напоминание|запись) (?:про|о|об|по|с|насчет)|${L}(?:была|был|было) ли (?:у меня )?)`,
);
const LIST = re(
  `(?:что у меня|что (?:на|в|во|за)\\s|что (?:сегодня|завтра|послезавтра)|какие (?:у меня )?(?:планы|дела|задачи|встречи|напоминания|события)|${L}(?:покажи|показать|выведи|перечисли|расскажи)|есть ли (?:у меня )?(?:встреч|задач|дел|план|напомин|что)|запланирован|расписани|мои (?:дела|задачи|встречи|планы|напоминания)|список|чем (?:я )?занят|свобод(?:ен|на) ли|я свобод|какой (?:у меня )?план|план на|что предстоит|сколько (?:у меня )?(?:задач|встреч|дел))`,
);
const CREATE = re(
  `${L}(?:напомни|напомнить|поставь|поставить|добавь|добавить|создай|создать|запиши|записать|запланируй|запланировать|назначь|назначить|внеси|нужно|надо|необходимо|не забыть|не забудь|должен|должна|хочу|встреча|встречу|созвон|совещание|планерка|задача|задачу|напоминание)${R}`,
);

export function detectIntent(raw: string): Intent {
  const t = norm(raw);
  if (!t) return "unknown";
  if (CANCEL.test(t)) return "cancel";
  if (UNDO.test(t)) return "undo";
  if (HELP.test(t)) return "help";
  if (GREETING.test(t)) return "greeting";
  if (THANKS.test(t) && !CREATE.test(t)) return "thanks";
  if (COMPLETE.test(t)) return "complete";
  if (DELETE.test(t) && !/^отмена$/.test(t)) return "delete";
  if (UPDATE.test(t)) return "update";
  if (SEARCH.test(t)) return "search";
  if (LIST.test(t) && !/^(?:напомни|добавь|поставь|создай|запиши|запланируй)/.test(t)) return "list";
  if (CREATE.test(t)) return "create";
  return "unknown";
}

const MEETING = re(
  `(?:встреч|встрет|созвон|совещан|планерк|митинг|собеседован|собрани|конференц|переговор|звонок с|видеозвон|обед с|ужин с|завтрак с|кофе с|свидани|при[её]м у|к врачу|у врача|к стоматологу|стоматолог|интервью|демо с|синк|стендап|1:1|one-on-one)`,
);
const REMINDER = re(`${L}(?:напомни|напомнить|напоминание|напоминалк)`);

export function detectType(raw: string): ItemType {
  const t = norm(raw);
  if (REMINDER.test(t)) return "reminder";
  if (MEETING.test(t)) return "meeting";
  return "task";
}

/** Type filter implied by a query ("какие встречи", "мои задачи"); undefined = all types. */
export function typesMentioned(raw: string): ItemType[] | undefined {
  const t = norm(raw);
  const types = new Set<ItemType>();
  if (/встреч|созвон|совещан|митинг|планерк/.test(t)) types.add("meeting");
  if (/задач|туду|todo/u.test(t)) {
    types.add("task");
    types.add("reminder");
  }
  if (/напомин/.test(t)) types.add("reminder");
  return types.size ? [...types] : undefined;
}

/** "Есть ли у меня…?" — answer should start with Да/Нет. */
export function isYesNoQuestion(raw: string): boolean {
  return /(?:^|\s)есть ли|(?:^|\s)свобод(?:ен|на) ли|(?:^|\s)занят(?:а)? ли/u.test(norm(raw));
}

export function mentionsPast(raw: string): boolean {
  return re(`${L}(?:был|была|было|были|прошл\\p{L}*|вчера|позавчера)${R}`).test(norm(raw));
}

export function mentionsFuture(raw: string): boolean {
  return re(`${L}(?:будет|будут|предстоит|следующ\\p{L}*)${R}`).test(norm(raw));
}

const YES = re(`^(?:да|давай|ага|угу|конечно|ок|окей|хорошо|верно|подтверждаю|все равно|всё равно|добавляй|добавь|оставь|точно|yes)(?![\\p{L}])`);
const NO = re(`^(?:нет|не надо|не нужно|не|отмена|не добавляй|no)(?![\\p{L}])`);

export function isYes(raw: string): boolean {
  return YES.test(norm(raw));
}
export function isNo(raw: string): boolean {
  return NO.test(norm(raw));
}

/** Pronoun / anaphora: "её", "его", "это", "последнюю" → previously discussed item. */
export function refersToPrevious(raw: string): boolean {
  return re(`${L}(?:ее|его|это|эту|этот|эта|последн\\p{L}*|предыдущ\\p{L}*|только что)${R}`).test(norm(raw));
}

const ORDINAL_PICK: Array<[RegExp, number]> = [
  [/(?:^|\s)(?:перв(?:ая|ую|ой|ое|ый|ого|ую)|1)(?:\s|$|[.)])/u, 0],
  [/(?:^|\s)(?:втор(?:ая|ую|ой|ое|ого)|2)(?:\s|$|[.)])/u, 1],
  [/(?:^|\s)(?:трет(?:ья|ью|ей|ье|ий|ьего)|3)(?:\s|$|[.)])/u, 2],
  [/(?:^|\s)(?:четверт(?:ая|ую|ой|ое|ый)|4)(?:\s|$|[.)])/u, 3],
  [/(?:^|\s)(?:пят(?:ая|ую|ой|ое|ый)|5)(?:\s|$|[.)])/u, 4],
];

/** "вторую", "2", "последнюю" → index into a list of options. */
export function pickIndex(raw: string, count: number): number | null {
  const t = ` ${norm(raw)} `;
  if (/последн/.test(t)) return count - 1;
  for (const [pattern, idx] of ORDINAL_PICK) if (pattern.test(t) && idx < count) return idx;
  return null;
}
