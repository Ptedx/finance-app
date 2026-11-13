/**
 * Maiúscula só na primeira letra do texto: "novembro 2026" vira "Novembro 2026", e
 * "17 de novembro de 2026" fica como está. O `textTransform: 'capitalize'` do estilo põe
 * maiúscula em toda palavra ("17 De Novembro De 2026") e não serve para datas (E2E-46).
 */
export const capitalizeFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
