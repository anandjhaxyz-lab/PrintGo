const {
  WIN32_DETECTED_ERROR_STATE,
  WIN32_EXTENDED_DETECTED_ERROR_STATE,
  parseStrictInteger,
  interpretDetectedErrorState,
  interpretExtendedDetectedErrorState,
  evaluatePrinterReadiness
} = require('../src/printerStatusMapping');

describe('Strict Integer and Whitespace Validation (Finding & Hardening)', () => {
  test('rejects whitespace-only strings safely as null', () => {
    expect(parseStrictInteger('')).toBeNull();
    expect(parseStrictInteger('   ')).toBeNull();
    expect(parseStrictInteger('\t\r\n')).toBeNull();
  });

  test('rejects fractional and decimal numbers without silent truncation', () => {
    expect(parseStrictInteger(0.8)).toBeNull();
    expect(parseStrictInteger('0.8')).toBeNull();
    expect(parseStrictInteger(2.5)).toBeNull();
    expect(parseStrictInteger('2.5')).toBeNull();
    expect(parseStrictInteger(-0.1)).toBeNull();
  });

  test('rejects NaN, Infinity and non-numeric types', () => {
    expect(parseStrictInteger(NaN)).toBeNull();
    expect(parseStrictInteger(Infinity)).toBeNull();
    expect(parseStrictInteger(-Infinity)).toBeNull();
    expect(parseStrictInteger(true)).toBeNull();
    expect(parseStrictInteger(false)).toBeNull();
    expect(parseStrictInteger({})).toBeNull();
    expect(parseStrictInteger([])).toBeNull();
    expect(parseStrictInteger('abc')).toBeNull();
  });

  test('accepts genuine integers and valid integer strings', () => {
    expect(parseStrictInteger(0)).toBe(0);
    expect(parseStrictInteger('0')).toBe(0);
    expect(parseStrictInteger(2)).toBe(2);
    expect(parseStrictInteger('2')).toBe(2);
    expect(parseStrictInteger(-1)).toBe(-1);
    expect(parseStrictInteger('-1')).toBe(-1);
  });
});

describe('Win32_Printer DetectedErrorState Standalone Interpretation (Fail-Closed)', () => {
  test('standalone interpretDetectedErrorState(0) remains blocking/unknown without corroboration', () => {
    const result = interpretDetectedErrorState(0);
    expect(result).not.toBeNull();
    expect(result.code).toBe(0);
    expect(result.name).toBe('Unknown');
    expect(result.isError).toBe(true);
    expect(result.isWarning).toBe(false);
    expect(result.isBlocking).toBe(true);
    expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    expect(result.message).toBe('Printer State Unknown');
  });

  test('correctly maps 2 as healthy (No Error) and eligible to print', () => {
    const result = interpretDetectedErrorState(2);
    expect(result).not.toBeNull();
    expect(result.code).toBe(2);
    expect(result.name).toBe('No Error');
    expect(result.isError).toBe(false);
    expect(result.isWarning).toBe(false);
    expect(result.isBlocking).toBe(false);
    expect(result.message).toBe('');
    expect(result.reason).toBeNull();
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

  test('handles null, undefined, whitespace, decimal and empty values safely as null', () => {
    expect(interpretDetectedErrorState(null)).toBeNull();
    expect(interpretDetectedErrorState(undefined)).toBeNull();
    expect(interpretDetectedErrorState('')).toBeNull();
    expect(interpretDetectedErrorState('   ')).toBeNull();
    expect(interpretDetectedErrorState('0.8')).toBeNull();
    expect(interpretDetectedErrorState('invalid-string')).toBeNull();
  });
});

describe('Win32_Printer ExtendedDetectedErrorState Enumeration', () => {
  test('standalone interpretExtendedDetectedErrorState(0) remains blocking/unknown', () => {
    const result = interpretExtendedDetectedErrorState(0);
    expect(result).not.toBeNull();
    expect(result.code).toBe(0);
    expect(result.name).toBe('Unknown');
    expect(result.isError).toBe(true);
    expect(result.isBlocking).toBe(true);
  });

  test('keeps DetectedErrorState and ExtendedDetectedErrorState enumerations distinct', () => {
    expect(interpretDetectedErrorState(9).name).toBe('Offline');
    expect(interpretDetectedErrorState(10).name).toBe('Service Requested');
    expect(interpretDetectedErrorState(11).name).toBe('Output Bin Full');
    expect(interpretExtendedDetectedErrorState(9).name).toBe('Service Requested');
    expect(interpretExtendedDetectedErrorState(10).name).toBe('Output Bin Full');
    expect(interpretExtendedDetectedErrorState(11).name).toBe('Paper Problem');
    expect(WIN32_EXTENDED_DETECTED_ERROR_STATE[15]).toBeDefined();
  });
});

describe('evaluatePrinterReadiness Corroborated Policy', () => {
  describe('Mandatory: Three Real Windows Printer Payload Shapes', () => {
    test('1. Epson L6460 payload shape evaluates to READY with full corroboration', () => {
      const epsonPayload = {
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        PortName: '192.168.1.7'
      };
      const result = evaluatePrinterReadiness(epsonPayload);
      expect(result).toEqual({
        canPrint: true,
        isError: false,
        isWarning: false,
        reason: null,
        message: ''
      });
    });

    test('2. HP LaserJet M1136 MFP payload shape evaluates to READY with full corroboration', () => {
      const hpPayload = {
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        PortName: 'USB011'
      };
      const result = evaluatePrinterReadiness(hpPayload);
      expect(result).toEqual({
        canPrint: true,
        isError: false,
        isWarning: false,
        reason: null,
        message: ''
      });
    });

    test('3. Canon Generic Plus UFR II payload shape evaluates to READY with full corroboration', () => {
      const canonPayload = {
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        PortName: 'USB001'
      };
      const result = evaluatePrinterReadiness(canonPayload);
      expect(result).toEqual({
        canPrint: true,
        isError: false,
        isWarning: false,
        reason: null,
        message: ''
      });
    });

    test('Works identically with camelCase field names', () => {
      const camelPayload = {
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0,
        workOffline: false,
        portName: '192.168.1.7'
      };
      const result = evaluatePrinterReadiness(camelPayload);
      expect(result).toEqual({
        canPrint: true,
        isError: false,
        isWarning: false,
        reason: null,
        message: ''
      });
    });
  });

  describe('Uncorroborated Code 0 and Missing / Malformed Fields Fail Closed', () => {
    test('DetectedErrorState: 0 without PrinterStatus fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });

    test('DetectedErrorState: 0 without ExtendedPrinterStatus fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });

    test('DetectedErrorState: 0 without ExtendedDetectedErrorState fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });

    test('DetectedErrorState: 0 with whitespace string fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: '   ',
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });

    test('DetectedErrorState: 0 with decimal value fails closed without truncation', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0.8,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });

    test('DetectedErrorState: 0 when PrinterStatus is busy (4 Printing) fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 4,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_BUSY');
    });

    test('DetectedErrorState: 0 when WorkOffline is true fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: true,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_OFFLINE');
    });

    test('DetectedErrorState: 0 when WorkOffline is null fails closed', () => {
      const result = evaluatePrinterReadiness({
        workOffline: null,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_STATE_UNKNOWN');
    });
  });

  describe('Genuine Blocking Errors and Warnings', () => {
    test('blocks when out of paper (DetectedErrorState = 4)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 4,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_NO_PAPER');
      expect(result.message).toBe('Out of Paper');
    });

    test('blocks when no toner (DetectedErrorState = 6)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 6,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_NO_TONER');
    });

    test('blocks when door open (DetectedErrorState = 7)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 7,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_DOOR_OPEN');
    });

    test('blocks when paper jam (DetectedErrorState = 8)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 8,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_PAPER_JAM');
    });

    test('allows dispatch with warning on Low Paper (DetectedErrorState = 3)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 3,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.isWarning).toBe(true);
      expect(result.message).toBe('Low Paper');
    });

    test('allows dispatch with warning on Low Toner (DetectedErrorState = 5)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 5,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.isWarning).toBe(true);
      expect(result.message).toBe('Low Toner');
    });
  });

  describe('Busy States & ExtendedPrinterStatus Variations', () => {
    test.each([
      [4, 'Printing'],
      [5, 'Warmup'],
      [10, 'Busy'],
      [12, 'Waiting'],
      [13, 'Processing'],
      [17, 'I/O Active']
    ])('blocks dispatch when ExtendedPrinterStatus is %i (%s)', (code) => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: code,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_BUSY');
    });

    test('blocks dispatch when ExtendedPrinterStatus indicates Paused (8)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 8,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      });
      expect(result.canPrint).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.reason).toBe('PRINTER_PAUSED');
    });
  });

  describe('Legacy Supported Status Combinations', () => {
    test('accepts legacy verified idle status with explicit 2 (No Error) and 3 (Idle)', () => {
      const result = evaluatePrinterReadiness({
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 3,
        detectedErrorState: 2,
        extendedDetectedErrorState: 2
      });
      expect(result).toEqual({
        canPrint: true,
        isError: false,
        isWarning: false,
        reason: null,
        message: ''
      });
    });
  });
});
