import { it, expect } from 'vitest';
import { validateCustomsDataset } from '../../services/customs-native/publication';
it('refuses empty, synthetic and missing source data before publication',()=>{
 expect(validateCustomsDataset({}).length).toBeGreaterThan(0);
 expect(validateCustomsDataset({test_data:true}).length).toBeGreaterThan(0);
});
