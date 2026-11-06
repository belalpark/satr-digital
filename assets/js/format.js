// Small Arabic formatting helpers shared by the views.

/** «16 مقعدًا» / «8 مقاعد» / «مقعد واحد» / «مقعدان» — Arabic number agreement. */
export function seatsLabel(n) {
  if (n === 1) return 'مقعد واحد';
  if (n === 2) return 'مقعدان';
  if (n >= 3 && n <= 10) return `${n} مقاعد`;
  return `${n} مقعدًا`;
}
