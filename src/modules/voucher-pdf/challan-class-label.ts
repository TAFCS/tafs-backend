/**
 * The class label a fee challan prints (TAFSD-551).
 *
 * The challan shows the class *code* (EY-I, JR-III, A2…), not the long
 * description ("EARLY YEARS - I"). A class whose code is blank falls back to
 * its description, and a voucher with no class at all prints "N/A", as before.
 * Used for the student's own class and for each sibling row.
 */
export function challanClassLabel(
    cls: { class_code?: string | null; description?: string | null } | null | undefined,
): string {
    const code = (cls?.class_code ?? '').trim();
    const description = (cls?.description ?? '').trim();
    return (code || description || 'N/A').toUpperCase();
}
