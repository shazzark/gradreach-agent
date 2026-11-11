export function readProfilePreferenceList(form: FormData, repeatedName: string, legacyName: string): string[] {
  const repeatedValues = form.getAll(repeatedName);
  if (repeatedValues.length) {
    if (!repeatedValues.every((value): value is string => typeof value === 'string')) throw new Error(`Invalid ${repeatedName} values`);
    const values = repeatedValues.map((value) => value.trim()).filter(Boolean);
    if (!values.length) throw new Error(`At least one ${repeatedName} value is required`);
    return values;
  }
  const legacyValue = form.get(legacyName);
  if (typeof legacyValue !== 'string') throw new Error(`At least one ${legacyName} value is required`);
  const values = legacyValue.split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error(`At least one ${legacyName} value is required`);
  return values;
}
