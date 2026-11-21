const {
  WIN32_DETECTED_ERROR_STATE,
  interpretDetectedErrorState
} = require('../src/printerStatusMapping');

describe('Win32_Printer DetectedErrorState Mapping and Policy (Finding 1)', () => {
  test('correctly maps 2 as healthy (No Error) and eligible to print', () => {
    const result = interpretDetectedErrorState(2);
    expect(result).not.toBeNull();
    expect(result.code).toBe(2);
    expect(result.name).toBe('No Error');
    expect(result.isError).toBe(false);
    expect(result.isWarning).toBe(false);
    expect(result.isBlocking).toBe(false);
    expect(result.message).toBe('');
  });

  test('correctly distinguishes warning states 3 (Low Paper) and 5 (Low Toner) without blocking print', () => {
    const lowPaper = interpretDetectedErrorState(3);
    expect(lowPaper.code).toBe(3);
    expect(lowPaper.name).toBe('Low Paper');
    expect(lowPaper.isError).toBe(false);
    expect(lowPaper.isWarning).toBe(true);
    expect(lowPaper.isBlocking).toBe(false);
    expect(lowPaper.message).toBe('Low Paper');

    const lowToner = interpretDetectedErrorState(5);
    expect(lowToner.code).toBe(5);
    expect(lowToner.name).toBe('Low Toner');
    expect(lowToner.isError).toBe(false);
    expect(lowToner.isWarning).toBe(true);
    expect(lowToner.isBlocking).toBe(false);
    expect(lowToner.message).toBe('Low Toner');
  });

  test('does not infer Paper Jam from Low Toner (5 vs 8)', () => {
    const lowToner = interpretDetectedErrorState(5);
    const jammed = interpretDetectedErrorState(8);

    expect(lowToner.message).toBe('Low Toner');
    expect(lowToner.isError).toBe(false);

    expect(jammed.message).toBe('Paper Jam');
    expect(jammed.name).toBe('Jammed');
    expect(jammed.isError).toBe(true);
    expect(jammed.isBlocking).toBe(true);
  });

  test('correctly maps all documented blocking error states', () => {
    const expected = [
      { code: 0, name: 'Unknown', isError: true, isBlocking: true, message: 'Printer State Unknown' },
      { code: 1, name: 'Other', isError: true, isBlocking: true, message: 'Printer Error' },
      { code: 4, name: 'No Paper', isError: true, isBlocking: true, message: 'Out of Paper' },
      { code: 6, name: 'No Toner', isError: true, isBlocking: true, message: 'No Toner' },
      { code: 7, name: 'Door Open', isError: true, isBlocking: true, message: 'Door Open' },
      { code: 8, name: 'Jammed', isError: true, isBlocking: true, message: 'Paper Jam' },
      { code: 9, name: 'Offline', isError: true, isBlocking: true, message: 'Printer Offline' },
      { code: 10, name: 'Service Requested', isError: true, isBlocking: true, message: 'Service Requested' },
      { code: 11, name: 'Output Bin Full', isError: true, isBlocking: true, message: 'Output Bin Full' }
    ];

    for (const exp of expected) {
      const res = interpretDetectedErrorState(exp.code);
      expect(res).not.toBeNull();
      expect(res.name).toBe(exp.name);
      expect(res.isError).toBe(exp.isError);
      expect(res.isBlocking).toBe(exp.isBlocking);
      expect(res.message).toBe(exp.message);
    }
  });

  test('does not silently classify unrecognized numeric values as healthy', () => {
    const unrec = interpretDetectedErrorState(99);
    expect(unrec.isError).toBe(true);
    expect(unrec.isBlocking).toBe(true);
    expect(unrec.name).toBe('Unrecognized');

    const neg = interpretDetectedErrorState(-1);
    expect(neg.isError).toBe(true);
    expect(neg.isBlocking).toBe(true);
  });

  test('handles null, undefined and empty values safely as null', () => {
    expect(interpretDetectedErrorState(null)).toBeNull();
    expect(interpretDetectedErrorState(undefined)).toBeNull();
    expect(interpretDetectedErrorState('')).toBeNull();
    expect(interpretDetectedErrorState('invalid-string')).toBeNull();
  });
});
