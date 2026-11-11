// Small Arabic formatting helpers shared by the views.

/** «16 مقعدًا» / «8 مقاعد» / «مقعد واحد» / «مقعدان» — Arabic number agreement. */
export function seatsLabel(n) {
  if (n === 1) return 'مقعد واحد';
  if (n === 2) return 'مقعدان';
  if (n >= 3 && n <= 10) return `${n} مقاعد`;
  return `${n} مقعدًا`;
}

/** «صورة واحدة» / «صورتان» / «5 صور» / «12 صورة» — Arabic number agreement for photo counts. */
export function photosLabel(n) {
  if (n === 1) return 'صورة واحدة';
  if (n === 2) return 'صورتان';
  if (n >= 3 && n <= 10) return `${n} صور`;
  return `${n} صورة`;
}
