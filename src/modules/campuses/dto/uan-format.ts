/**
 * TAFSD-549: how a campus UAN is written: 111 then two groups of three digits,
 * e.g. 111-823-723. An empty string is allowed: it clears the UAN.
 */
export const UAN_FORMAT = /^(?:111-\d{3}-\d{3})?$/;
