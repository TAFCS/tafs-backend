import { challanClassLabel } from './challan-class-label';

describe('challanClassLabel (TAFSD-551)', () => {
    it('prints the class code instead of the description', () => {
        expect(challanClassLabel({ class_code: 'EY-I', description: 'EARLY YEARS - I' })).toBe('EY-I');
        expect(challanClassLabel({ class_code: 'jr-iii', description: 'Junior III' })).toBe('JR-III');
    });

    it('falls back to the description when the code is blank', () => {
        expect(challanClassLabel({ class_code: '', description: 'Early Years - I' })).toBe('EARLY YEARS - I');
        expect(challanClassLabel({ class_code: '   ', description: 'A2' })).toBe('A2');
        expect(challanClassLabel({ class_code: null, description: 'AS' })).toBe('AS');
    });

    it('prints N/A when there is no class', () => {
        expect(challanClassLabel(null)).toBe('N/A');
        expect(challanClassLabel(undefined)).toBe('N/A');
        expect(challanClassLabel({ class_code: '', description: '' })).toBe('N/A');
    });
});
