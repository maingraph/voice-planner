import { stem } from "./text.js";

/**
 * Small hand-made thesaurus for the planner domain. It makes "договор" find "контракт"
 * even without an LLM or embeddings. In LLM mode the model adds its own related terms on top.
 */
const GROUPS: string[][] = [
  ["договор", "контракт", "соглашение", "оферта"],
  ["презентация", "слайды", "доклад", "выступление", "питч"],
  ["встреча", "созвон", "совещание", "митинг", "планерка", "собрание", "встреча"],
  ["звонок", "позвонить", "созвониться", "набрать", "созвон"],
  ["отчет", "отчетность", "репорт"],
  ["билет", "билеты", "авиабилет", "поезд", "самолет", "перелет"],
  ["врач", "доктор", "больница", "поликлиника", "стоматолог", "клиника"],
  ["купить", "покупка", "заказать", "магазин", "приобрести"],
  ["письмо", "почта", "email", "написать", "ответить"],
  ["дизайнер", "дизайн", "макет", "макеты"],
  ["оплатить", "оплата", "счет", "платеж", "заплатить"],
  ["подарок", "день", "рождения", "праздник"],
  ["код", "ревью", "релиз", "деплой", "баг"],
  ["собеседование", "интервью", "кандидат", "найм"],
  ["бюджет", "смета", "финансы", "расходы"],
  ["спортзал", "тренировка", "зал", "фитнес"],
];

const index = new Map<string, Set<string>>();
for (const group of GROUPS) {
  const groupStems = group.map(stem);
  for (const s of groupStems) {
    const set = index.get(s) ?? new Set<string>();
    groupStems.forEach((g) => g !== s && set.add(g));
    index.set(s, set);
  }
}

export function synonymStems(termStem: string): string[] {
  return [...(index.get(termStem) ?? [])];
}
