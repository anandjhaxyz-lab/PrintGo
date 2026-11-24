import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import axios from 'axios';
import {
  Upload, CheckCircle, Loader, CreditCard, Banknote,
  WifiOff, Printer, AlertTriangle, RefreshCw, FileText,
  ShieldCheck, ChevronRight, ChevronLeft, Check, Eye,
  Download, Receipt, RotateCcw, Zap, Sparkles, Lock
} from 'lucide-react';
import { StepIndicator } from '../components/mobile/StepIndicator';
import { AdvertisementDisplay } from '../components/AdvertisementDisplay';
import { DocumentPreviewModal } from '../components/DocumentPreviewModal';
import { PDFDocument } from 'pdf-lib';
import forge from 'node-forge';
import { getApiUrl } from '../utils/apiConfig';
import {
  DEFAULT_PRICING_PROFILE,
  parseCustomPageRange,
  calculatePrintBreakdown,
} from '../utils/pricingCalculator';
import {
  loadRecoveredSession,
  saveRecoveredSession,
  clearRecoveredJob,
} from '../utils/sessionRecovery';
import {
  launchCashfreeCheckout,
  normalizeCashfreeMode,
} from '../utils/cashfreeCheckout';

const API_URL = getApiUrl();

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/acrobat',
  'applications/vnd.pdf',
  'text/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const ALLOWED_FILE_EXT_REGEX = /\.(pdf|jpe?g|png|webp)$/i;
const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp)$/i;

const isSupportedUploadFile = (file) => {
  if (!file) return false;
  const hasAllowedExt = ALLOWED_FILE_EXT_REGEX.test(file.name || '');
  const hasAllowedMime = file.type ? ALLOWED_MIME_TYPES.has(file.type.toLowerCase()) : false;
  // Require extension validity when present so Office/unsupported files cannot slip through
  if (file.name && !hasAllowedExt) return false;
  return hasAllowedExt || hasAllowedMime;
};

const convertImageBufferToJpegOrPng = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '');
  const isJpg = file.type === 'image/jpeg' || file.type === 'image/jpg' || /\.jpe?g$/i.test(file.name || '');
  if (isPng || isJpg) {
    return { buffer: arrayBuffer, format: isPng ? 'png' : 'jpg' };
  }
  // Convert WEBP or other supported browser-decodable image formats to JPEG via canvas if available
  if (typeof document !== 'undefined' && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (jpegBlob) {
      return { buffer: await jpegBlob.arrayBuffer(), format: 'jpg' };
    }
  }
  return { buffer: arrayBuffer, format: 'jpg' };
};

const MobileView = () => {
  const { sessionId, publicCode } = useParams();
  const scopeParams = useMemo(() => ({ publicCode, sessionId }), [publicCode, sessionId]);

  const [activeSessionId, setActiveSessionId] = useState(sessionId || null);
  const [printerInfo, setPrinterInfo] = useState(null);
  const [pricingProfile, setPricingProfile] = useState(DEFAULT_PRICING_PROFILE);
  const [cashfreeEnv, setCashfreeEnv] = useState('sandbox');
  const [qrError, setQrError] = useState(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);

  const hardwareStatus = printerInfo?.hardwareStatus || (printerInfo?.isOnline ? 'ONLINE' : (printerInfo ? 'AGENT_OFFLINE' : 'UNKNOWN'));
  const isPrinterReady = hardwareStatus === 'ONLINE';
  const isAgentOffline = hardwareStatus === 'AGENT_OFFLINE';
  const isPrinterDisconnected = hardwareStatus === 'PRINTER_DISCONNECTED';

  const customerStatusText = useMemo(() => {
    if (printerInfo?.statusMessage) return printerInfo.statusMessage;
    switch (hardwareStatus) {
      case 'ONLINE':
        return 'Printer Ready';
      case 'AGENT_OFFLINE':
        return 'Printer Temporarily Offline';
      case 'PRINTER_DISCONNECTED':
        return 'Printer Disconnected';
      case 'PAPER_OUT':
        return 'Out of Paper';
      case 'JAMMED':
        return 'Paper Jam';
      case 'UNKNOWN':
      default:
        return 'Printer Status Unavailable';
    }
  }, [hardwareStatus, printerInfo?.statusMessage]);

  const handleRefreshPrinterStatus = async () => {
    setIsRefreshingStatus(true);
    try {
      if (publicCode) {
        const res = await axios.get(`${API_URL}/api/auth/printer-qr/${publicCode}`);
        if (res.data?.printer) {
          setPrinterInfo(res.data.printer);
        }
      } else if (activeSessionId || sessionId) {
        const res = await axios.get(`${API_URL}/api/auth/pricing`, {
          params: publicCode ? { publicCode } : {},
        });
        if (res.data?.printer) {
          setPrinterInfo(res.data.printer);
        }
      }
    } catch (err) {
      console.warn('Failed to refresh printer status:', err);
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(true);
  const [step, setStep] = useState(1);
  const [fileData, setFileData] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [orderId, setOrderId] = useState(null);
  const [jobStatus, setJobStatus] = useState('WAITING');
  const [uploading, setUploading] = useState(false);
  const [isSubmittingSettings, setIsSubmittingSettings] = useState(false);
  const [isInitializingPayment, setIsInitializingPayment] = useState(false);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [paymentOutcome, setPaymentOutcome] = useState(null); // { type: 'FAILED'|'CANCELLED'|'DROPPED'|'PENDING'|'MISMATCH', message }
  const [paymentMode, setPaymentMode] = useState('CASH_AT_COUNTER'); // 'CASH_AT_COUNTER' | 'DEMO_SIMULATION' | 'CASHFREE_ONLINE'
  const [enableDemoPayment, setEnableDemoPayment] = useState(false);
  const [demoAccessCode, setDemoAccessCode] = useState('');
  const [demoAccessCodeRequired, setDemoAccessCodeRequired] = useState(true);
  const [isExecutingDemoPay, setIsExecutingDemoPay] = useState(false);
  const [dispatchWarning, setDispatchWarning] = useState(null);
  const [error, setError] = useState('');
  const [price, setPrice] = useState(0);
  const [serverBreakdown, setServerBreakdown] = useState(null);
  const [sessionToken, setSessionToken] = useState(null);

  // Invoice / Receipt State (Step 4)
  const [invoiceData, setInvoiceData] = useState(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);

  // Document Preview & Page Selection State
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewFileName, setPreviewFileName] = useState(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [rangeValidationError, setRangeValidationError] = useState(null);

  // E2E Encryption State
  const [publicKey, setPublicKey] = useState(null);
  const [encryptedKey, setEncryptedKey] = useState(null);
  const [iv, setIv] = useState(null);

  // Refs for cleanup and concurrency guards
  const previewUrlRef = useRef(null);
  const checkoutInFlightRef = useRef(false);
  const demoPayInFlightRef = useRef(false);
  const submitSettingsInFlightRef = useRef(false);

  const [settings, setSettings] = useState({
    color: 'bw',
    duplex: 'single',
    copies: 1,
    pageRangeType: 'all',
    customRange: '',
    pagesToPrint: 1,
  });

  // Safe error extractor: guarantees a user-friendly string, never an Object
  const extractErrorMessage = (err, fallback = 'An unexpected error occurred. Please try again.') => {
    if (!err) return fallback;
    if (typeof err === 'string') return err;
    const data = err.response?.data;
    if (data) {
      if (typeof data.message === 'string' && data.message.trim()) return data.message;
      if (typeof data.error === 'string' && data.error.trim()) return data.error;
      if (typeof data.error?.message === 'string' && data.error.message.trim()) return data.error.message;
    }
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    return fallback;
  };

  const authHeaders = useCallback(
    (token = sessionToken) => (token ? { Authorization: `Bearer ${token}` } : {}),
    [sessionToken]
  );

  const showError = useCallback((msg) => {
    const safeMsg = typeof msg === 'string' ? msg : extractErrorMessage(msg);
    setError(safeMsg);
    setTimeout(() => setError(''), 7000);
  }, []);

  // Revoke previous Blob object URLs on replacement or unmount
  const assignPreviewBlob = useCallback((blob, fileNameForModal) => {
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(previewUrlRef.current);
      } catch {
        // ignore
      }
      previewUrlRef.current = null;
    }
    if (blob instanceof Blob) {
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setPreviewFileName(fileNameForModal || null);
    } else {
      setPreviewUrl(null);
      setPreviewFileName(fileNameForModal || null);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(previewUrlRef.current);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // Live dynamic pricing breakdown for Step 2 (matches server calculation engine)
  const liveBreakdown = useMemo(
    () => calculatePrintBreakdown(settings, fileData?.pages || 1, pricingProfile),
    [settings, fileData?.pages, pricingProfile]
  );

  // Authoritative payment verification against backend (NEVER trusts client redirect or socket alone)
  const verifyPaymentStatus = useCallback(
    async (targetId, activeToken = sessionToken) => {
      const idToVerify = targetId || orderId || jobId;
      if (!idToVerify || !activeToken) {
        setIsVerifyingPayment(false);
        return { verified: false, status: 'PENDING' };
      }

      try {
        const res = await axios.get(`${API_URL}/api/payments/verify/${encodeURIComponent(idToVerify)}`, {
          headers: { Authorization: `Bearer ${activeToken}` },
        });

        const returnedStatus = String(res.data?.status || res.data?.job?.status || '').toUpperCase();
        const returnedJob = res.data?.job;

        if (res.data?.success && returnedJob && returnedJob.status !== 'PENDING_PAYMENT') {
          setIsVerifyingPayment(false);
          setPaymentOutcome(null);
          setJobId(returnedJob.shortId || jobId);
          setJobStatus(returnedJob.status || 'WAITING');
          setStep(4);
          saveRecoveredSession(scopeParams, {
            jobId: returnedJob.shortId || jobId,
            orderId: orderId || null,
            paymentState: 'PAID',
          });
          try {
            window.history.replaceState({}, document.title, window.location.pathname);
          } catch {
            // ignore history error
          }
          return { verified: true, status: returnedJob.status, job: returnedJob };
        }

        if (['FAILED', 'CANCELLED', 'USER_DROPPED', 'AMOUNT_MISMATCH'].includes(returnedStatus)) {
          setIsVerifyingPayment(false);
          const failureMessages = {
            FAILED: 'Payment failed at Cashfree. No print job was queued.',
            CANCELLED: 'Payment was cancelled before completion.',
            USER_DROPPED: 'Checkout was closed before completing payment.',
            AMOUNT_MISMATCH: 'Payment amount mismatch detected by server verification. Contact shop staff if debited.',
          };
          const outcome = {
            type: returnedStatus === 'USER_DROPPED' ? 'DROPPED' : returnedStatus,
            message: failureMessages[returnedStatus] || 'Payment could not be completed.',
          };
          setPaymentOutcome(outcome);
          saveRecoveredSession(scopeParams, { paymentState: outcome.type });
          return { verified: false, status: returnedStatus };
        }

        setIsVerifyingPayment(false);
        return { verified: false, status: returnedStatus || 'PENDING' };
      } catch (err) {
        console.error('Verify payment error:', err);
        setIsVerifyingPayment(false);
        return { verified: false, status: 'ERROR', error: extractErrorMessage(err) };
      }
    },
    [sessionToken, orderId, jobId, scopeParams]
  );

  // Acquire or recover session on mount: supports /p/:publicCode, /m/:sessionId, and Cashfree redirect return
  useEffect(() => {
    let newSocket = null;
    let cancelled = false;

    const acquireOrRecoverSession = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlOrderId = params.get('order_id');
        const urlJobId = params.get('job_id');
        const recovered = loadRecoveredSession(scopeParams);

        let token = recovered?.sessionToken || null;
        let effectiveCode = recovered?.sessionCode || null;
        let machineIdToFetch = recovered?.machineId || null;

        if (token && effectiveCode) {
          // Restore non-secret UI state cleanly across Cashfree redirects / refreshes
          setSessionToken(token);
          setActiveSessionId(effectiveCode);
          if (recovered.printerInfo) setPrinterInfo(recovered.printerInfo);
          if (recovered.pricingProfile) setPricingProfile(recovered.pricingProfile);
          if (recovered.cashfreeEnv) setCashfreeEnv(normalizeCashfreeMode(recovered.cashfreeEnv));
          const recoveredMode = recovered.paymentMode || (recovered.enableDemoPayment ? 'DEMO_SIMULATION' : (recovered.cashfreeEnv || recovered.orderId ? 'CASHFREE_ONLINE' : 'CASH_AT_COUNTER'));
          setPaymentMode(recoveredMode);
          if (recovered.enableDemoPayment !== undefined) setEnableDemoPayment(Boolean(recovered.enableDemoPayment));
          if (recovered.demoAccessCodeRequired !== undefined) setDemoAccessCodeRequired(Boolean(recovered.demoAccessCodeRequired));
          if (recovered.fileData) setFileData(recovered.fileData);
          if (recovered.settings) setSettings(recovered.settings);
          if (recovered.price) setPrice(recovered.price);
          if (recovered.pricingBreakdown) setServerBreakdown(recovered.pricingBreakdown);
          if (urlJobId || recovered.jobId) setJobId(urlJobId || recovered.jobId);
          if (urlOrderId || recovered.orderId) setOrderId(urlOrderId || recovered.orderId);

          // Restore E2E encryption keys if session was encrypted
          if (recovered.e2e?.isEncrypted) {
            if (recovered.e2e.encryptedKey) setEncryptedKey(recovered.e2e.encryptedKey);
            if (recovered.e2e.iv) setIv(recovered.e2e.iv);
          }

          // Advance to Step 2 if file was already uploaded and no checkout is active
          if (recovered.fileData && !urlOrderId && !urlJobId && !recovered.jobId) {
            setStep(2);
          }

          // Rehydrate preview Blob URL from the authenticated preview endpoint
          if (recovered.fileData?.filename && token) {
            const diskFilename = recovered.fileData.filename.split('/').pop();
            axios
              .get(`${API_URL}/api/upload/preview/${encodeURIComponent(diskFilename)}`, {
                headers: { Authorization: `Bearer ${token}` },
                responseType: 'arraybuffer',
              })
              .then(async (res) => {
                if (cancelled || !res.data) return;
                let finalBuffer = res.data;

                // Client-side decryption if the recovered file was E2E encrypted
                if (recovered.e2e?.isEncrypted && recovered.e2e?.rawKey && recovered.e2e?.rawIv) {
                  try {
                    const rawKeyStr = forge.util.decode64(recovered.e2e.rawKey);
                    const rawIvStr = forge.util.decode64(recovered.e2e.rawIv);
                    const rawKeyBytes = new Uint8Array(rawKeyStr.length);
                    for (let i = 0; i < rawKeyStr.length; i++) rawKeyBytes[i] = rawKeyStr.charCodeAt(i);
                    const rawIvBytes = new Uint8Array(rawIvStr.length);
                    for (let i = 0; i < rawIvStr.length; i++) rawIvBytes[i] = rawIvStr.charCodeAt(i);

                    const cryptoKey = await window.crypto.subtle.importKey(
                      'raw',
                      rawKeyBytes,
                      { name: 'AES-GCM' },
                      false,
                      ['decrypt']
                    );
                    finalBuffer = await window.crypto.subtle.decrypt(
                      { name: 'AES-GCM', iv: rawIvBytes },
                      cryptoKey,
                      res.data
                    );
                  } catch (decErr) {
                    console.warn('Client-side decryption of recovered preview failed:', decErr);
                    return;
                  }
                }

                const mime = recovered.fileData.mimetype || 'application/pdf';
                const blob = new Blob([finalBuffer], { type: mime });
                assignPreviewBlob(blob, recovered.fileData.originalName);
              })
              .catch((err) => {
                const status = err.response?.status;
                console.warn('Preview blob rehydration status:', status || err.message);
                if (status === 410) {
                  clearRecoveredSession(scopeParams);
                  setStep(1);
                  showError('Session expired. Please scan the QR flyer again.');
                }
              });
          }

          // Best-effort live pricing profile refresh without minting a new session
          axios
            .get(`${API_URL}/api/auth/pricing`, {
              params: publicCode ? { publicCode } : {},
            })
            .then((pRes) => {
              if (!cancelled && pRes.data?.success) {
                if (pRes.data.pricingProfile) setPricingProfile(pRes.data.pricingProfile);
                if (pRes.data.cashfreeEnv) setCashfreeEnv(normalizeCashfreeMode(pRes.data.cashfreeEnv));
                const modeFromPricing = pRes.data.paymentMode || (pRes.data.enableDemoPayment ? 'DEMO_SIMULATION' : (pRes.data.cashfreeEnv ? 'CASHFREE_ONLINE' : null));
                if (modeFromPricing) setPaymentMode(modeFromPricing);
                if (pRes.data.enableDemoPayment !== undefined) setEnableDemoPayment(Boolean(pRes.data.enableDemoPayment));
                if (pRes.data.demoAccessCodeRequired !== undefined) setDemoAccessCodeRequired(Boolean(pRes.data.demoAccessCodeRequired));
              }
            })
            .catch(() => {});
        } else if (publicCode) {
          const res = await axios.post(`${API_URL}/api/auth/session/from-printer-qr`, { publicCode });
          if (res.data.success) {
            token = res.data.sessionToken;
            effectiveCode = res.data.sessionCode;
            setSessionToken(token);
            setActiveSessionId(effectiveCode);
            if (res.data.printer) setPrinterInfo(res.data.printer);
            if (res.data.pricingProfile) setPricingProfile(res.data.pricingProfile);
            const envMode = normalizeCashfreeMode(res.data.cashfreeEnv);
            setCashfreeEnv(envMode);
            const resolvedPaymentMode = res.data.paymentMode || (res.data.enableDemoPayment ? 'DEMO_SIMULATION' : (res.data.cashfreeEnv ? 'CASHFREE_ONLINE' : 'CASH_AT_COUNTER'));
            setPaymentMode(resolvedPaymentMode);
            const demoAllowed = Boolean(res.data.enableDemoPayment);
            setEnableDemoPayment(demoAllowed);
            const demoCodeRequired = res.data.demoAccessCodeRequired !== false;
            setDemoAccessCodeRequired(demoCodeRequired);

            saveRecoveredSession(scopeParams, {
              publicCode,
              sessionCode: effectiveCode,
              sessionToken: token,
              printerInfo: res.data.printer || null,
              pricingProfile: res.data.pricingProfile || DEFAULT_PRICING_PROFILE,
              cashfreeEnv: envMode,
              paymentMode: resolvedPaymentMode,
              enableDemoPayment: demoAllowed,
              demoAccessCodeRequired: demoCodeRequired,
              expiresAt: res.data.expiresAt || null,
            });
          }
        } else if (sessionId) {
          const res = await axios.post(`${API_URL}/api/auth/session/join`, { sessionCode: sessionId });
          if (res.data.success) {
            token = res.data.sessionToken;
            effectiveCode = sessionId;
            machineIdToFetch = res.data.machineId;
            setSessionToken(token);
            setActiveSessionId(sessionId);
            if (res.data.pricingProfile) setPricingProfile(res.data.pricingProfile);
            const envMode = normalizeCashfreeMode(res.data.cashfreeEnv);
            setCashfreeEnv(envMode);
            const resolvedPaymentMode = res.data.paymentMode || (res.data.enableDemoPayment ? 'DEMO_SIMULATION' : (res.data.cashfreeEnv ? 'CASHFREE_ONLINE' : 'CASH_AT_COUNTER'));
            setPaymentMode(resolvedPaymentMode);
            const demoAllowed = Boolean(res.data.enableDemoPayment);
            setEnableDemoPayment(demoAllowed);
            const demoCodeRequired = res.data.demoAccessCodeRequired !== false;
            setDemoAccessCodeRequired(demoCodeRequired);

            saveRecoveredSession(scopeParams, {
              sessionCode: effectiveCode,
              sessionToken: token,
              machineId: res.data.machineId || null,
              pricingProfile: res.data.pricingProfile || DEFAULT_PRICING_PROFILE,
              cashfreeEnv: envMode,
              paymentMode: resolvedPaymentMode,
              enableDemoPayment: demoAllowed,
              demoAccessCodeRequired: demoCodeRequired,
              expiresAt: res.data.expiresAt || null,
            });
          }
        } else {
          setQrError({
            title: 'No Session Specified',
            message: 'Please scan the permanent QR flyer displayed on the printer counter.',
          });
          return;
        }

        if (cancelled || !token || !effectiveCode) return;

        newSocket = io(API_URL, {
          transports: ['websocket'],
          auth: { token },
        });
        setSocket(newSocket);

        newSocket.on('connect', () => {
          setIsConnected(true);
          newSocket.emit('join_session', effectiveCode);
          newSocket.emit('mobile_connected', effectiveCode);
          // Re-fetch authoritative status after reconnection
          if (publicCode) {
            axios
              .get(`${API_URL}/api/auth/printer-qr/${publicCode}`)
              .then((pRes) => {
                if (!cancelled && pRes.data?.printer) setPrinterInfo(pRes.data.printer);
              })
              .catch(() => {});
          }
        });

        newSocket.on('disconnect', () => setIsConnected(false));
        newSocket.on('connect_error', () => setIsConnected(false));

        newSocket.on('printer_status_update', (statusData) => {
          if (!cancelled && statusData && typeof statusData === 'object') {
            setPrinterInfo((prev) => ({
              ...(prev || {}),
              name: statusData.name || prev?.name || 'Counter Printer',
              location: statusData.location || prev?.location || 'Front Desk',
              model: statusData.printerModel || prev?.model || 'Unknown',
              isOnline: statusData.isReady ?? statusData.isOnline ?? false,
              hardwareStatus: statusData.hardwareStatus || statusData.status || (statusData.isOnline ? 'ONLINE' : 'AGENT_OFFLINE'),
              statusMessage: statusData.statusMessage,
              paperStatus: statusData.paperStatus,
              tonerStatus: statusData.tonerStatus,
              jamStatus: statusData.jamStatus,
            }));
          }
        });

        // Security rule: socket payment notifications MUST verify server-side rather than trusting event alone
        newSocket.on('kiosk_payment_success', async ({ jobId: eventJobId } = {}) => {
          await verifyPaymentStatus(eventJobId || urlOrderId || urlJobId, token);
        });

        newSocket.on('session_cancelled', () => {
          showError('Session expired or cancelled. Please scan the printer QR again.');
          setStep(1);
        });

        newSocket.on('job_status_changed', (job) => {
          if (job?.status) {
            setJobStatus(job.status);
          }
          if (job && ['WAITING', 'PRINTING', 'COMPLETED'].includes(job.status)) {
            setIsVerifyingPayment(false);
            setStep(4);
          }
        });

        if (machineIdToFetch) {
          axios
            .get(`${API_URL}/api/machines/${machineIdToFetch}/public-key`)
            .then((pkRes) => {
              if (!cancelled && pkRes.data.success) setPublicKey(pkRes.data.publicKey);
            })
            .catch(() => {});
        }

        const effectiveJobToCheck = urlJobId || recovered?.jobId;
        if (urlOrderId) {
          setStep(3);
          setIsVerifyingPayment(true);
          let attempts = 0;
          const runCheck = async () => {
            attempts += 1;
            const result = await verifyPaymentStatus(urlOrderId, token);
            if (result.verified || ['FAILED', 'CANCELLED', 'USER_DROPPED', 'AMOUNT_MISMATCH'].includes(result.status)) {
              return true;
            }
            if (attempts >= 12) {
              setIsVerifyingPayment(false);
              setPaymentOutcome({
                type: 'PENDING',
                message: 'Payment confirmation is taking longer than usual. Tap "Check Payment Status" or retry below.',
              });
              return true;
            }
            return false;
          };

          const doneImmediately = await runCheck();
          if (!doneImmediately && !cancelled) {
            const poller = setInterval(async () => {
              if (cancelled) {
                clearInterval(poller);
                return;
              }
              const done = await runCheck();
              if (done) clearInterval(poller);
            }, 2500);
          }
        } else if (effectiveJobToCheck) {
          setStep(3);
          try {
            const jobRes = await axios.get(`${API_URL}/api/jobs/${effectiveJobToCheck}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!cancelled && jobRes.data?.success && jobRes.data.job) {
              const restoredJob = jobRes.data.job;
              setPrice(restoredJob.cost);
              setJobStatus(restoredJob.status);
              if (restoredJob.paymentMode) {
                setPaymentMode(restoredJob.paymentMode);
              }
              if (['WAITING', 'PRINTING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(restoredJob.status)) {
                setStep(4);
              }
            }
          } catch {
            // If old job belonged to another expired session, reset cleanly to Step 1
            clearRecoveredJob(scopeParams);
            setJobId(null);
            setOrderId(null);
            setStep(1);
          }
        }
      } catch (err) {
        console.error('Failed to acquire session:', err);
        const status = err.response?.status;
        const msg = extractErrorMessage(err, 'Failed to initialize print session.');

        if (status === 410) {
          setQrError({
            title: 'QR Code Expired / Replaced',
            message: msg || 'This printer QR flyer has been replaced or revoked. Please scan the current flyer on the printer.',
          });
        } else if (status === 403) {
          setQrError({
            title: 'Printer Offline / Inactive',
            message: msg || 'This printer is currently offline or undergoing maintenance. Please ask store staff.',
          });
        } else if (status === 404) {
          setQrError({
            title: 'Unrecognized QR Code',
            message: msg || 'This QR code is not recognized by S3K PrintGo.',
          });
        } else {
          showError(msg);
        }
      }
    };

    acquireOrRecoverSession();

    return () => {
      cancelled = true;
      if (newSocket) newSocket.close();
    };
  }, [sessionId, publicCode]);

  // Step 4: Poll print progress & fetch customer receipt/invoice once confirmed paid
  useEffect(() => {
    if (step !== 4 || !jobId || !sessionToken) return undefined;

    let stopped = false;
    const fetchJobAndInvoice = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}`, {
          headers: authHeaders(),
        });
        if (!stopped && res.data?.success && res.data.job) {
          setJobStatus(res.data.job.status);
        }
      } catch {
        // ignore transient poll failure
      }

      if (!invoiceData) {
        setInvoiceLoading(true);
        try {
          const invRes = await axios.get(`${API_URL}/api/jobs/${encodeURIComponent(jobId)}/invoice`, {
            headers: authHeaders(),
          });
          if (!stopped && invRes.data?.success && invRes.data.invoice) {
            setInvoiceData(invRes.data.invoice);
          }
        } catch {
          // Invoice may still be finalizing; next poll retries automatically
        } finally {
          if (!stopped) setInvoiceLoading(false);
        }
      }
    };

    fetchJobAndInvoice();
    const poller = setInterval(fetchJobAndInvoice, 3000);
    return () => {
      stopped = true;
      clearInterval(poller);
    };
  }, [step, jobId, sessionToken, invoiceData, authHeaders]);

  // Step 3 background verify poll (only active once an orderId has been created & user is not mid-modal)
  useEffect(() => {
    if (step !== 3 || !orderId || !sessionToken || isInitializingPayment) return undefined;
    const interval = setInterval(async () => {
      if (!checkoutInFlightRef.current) {
        await verifyPaymentStatus(orderId, sessionToken);
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [step, orderId, sessionToken, isInitializingPayment, verifyPaymentStatus]);

  // Update pricing & emit settings sync in Step 2
  useEffect(() => {
    if (!fileData) return;
    if (settings.pagesToPrint !== liveBreakdown.pagesToPrint) {
      setSettings((prev) => ({ ...prev, pagesToPrint: liveBreakdown.pagesToPrint }));
    }
    if (step <= 2) {
      setPrice(liveBreakdown.totalAmount);
    }

    const currentSid = activeSessionId || sessionId;
    if (socket && currentSid) {
      socket.emit('settings_updated', {
        sessionId: currentSid,
        settingsData: { ...settings, pagesToPrint: liveBreakdown.pagesToPrint },
        price: liveBreakdown.totalAmount,
      });
    }
  }, [
    settings.color,
    settings.duplex,
    settings.copies,
    settings.pageRangeType,
    settings.customRange,
    liveBreakdown.pagesToPrint,
    liveBreakdown.totalAmount,
    fileData,
    socket,
    activeSessionId,
    sessionId,
    step,
  ]);

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files || files.length === 0) return;

    // Validate strict pilot file format support before doing any conversion or upload
    const unsupportedFile = files.find((f) => !isSupportedUploadFile(f));
    if (unsupportedFile) {
      showError(
        `Unsupported file format (${unsupportedFile.name}). Only PDF and Images (PNG, JPG, JPEG, WEBP) are supported.`
      );
      e.target.value = '';
      return;
    }

    const totalSize = files.reduce((acc, file) => acc + file.size, 0);
    if (totalSize > 50 * 1024 * 1024) {
      showError('Total file size exceeds 50MB limit.');
      e.target.value = '';
      return;
    }

    setUploading(true);
    // Reset stale job/payment state when customer uploads a new document
    clearRecoveredJob(scopeParams);
    setJobId(null);
    setOrderId(null);
    setPaymentOutcome(null);
    setServerBreakdown(null);
    setInvoiceData(null);

    try {
      let payloadToUpload = files[0];
      let claimedPages = 1;
      let isEncrypted = false;
      let finalFileName = files.length > 1 ? `Merged_${files.length}_Files.pdf` : files[0].name;

      const isSingleImage =
        files.length === 1 &&
        (files[0].type?.startsWith('image/') || IMAGE_EXT_REGEX.test(files[0].name || ''));

      if (files.length > 1 || isSingleImage) {
        // Convert single image or multiple PDFs/Images into a single printable PDF via pdf-lib
        try {
          const mergedPdf = await PDFDocument.create();
          for (const file of files) {
            const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
            if (isPdf) {
              const arrayBuffer = await file.arrayBuffer();
              const pdf = await PDFDocument.load(arrayBuffer);
              const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
              copiedPages.forEach((page) => mergedPdf.addPage(page));
            } else {
              const { buffer, format } = await convertImageBufferToJpegOrPng(file);
              const image = format === 'png'
                ? await mergedPdf.embedPng(buffer)
                : await mergedPdf.embedJpg(buffer);
              const page = mergedPdf.addPage([image.width, image.height]);
              page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            }
          }
          const mergedPdfBytes = await mergedPdf.save();
          claimedPages = mergedPdf.getPageCount();
          payloadToUpload = new Blob([mergedPdfBytes], { type: 'application/pdf' });
          if (isSingleImage) {
            finalFileName = `${(files[0].name || 'photo').replace(IMAGE_EXT_REGEX, '')}.pdf`;
          }
        } catch (convErr) {
          // If multi-file failed, abort cleanly; for single image in limited test environments keep original image
          if (files.length > 1) {
            throw convErr;
          }
          payloadToUpload = files[0];
          claimedPages = 1;
        }
      } else {
        // Single PDF: inspect local page count before any encryption
        try {
          const pdfBuf = await files[0].arrayBuffer();
          const pdfDoc = await PDFDocument.load(pdfBuf);
          claimedPages = Math.max(1, pdfDoc.getPageCount());
        } catch {
          claimedPages = 1;
        }
      }

      // CRITICAL FIX: Capture unencrypted preview Blob BEFORE E2E AES-GCM encryption!
      const previewBlob = payloadToUpload instanceof Blob ? payloadToUpload : files[0];
      assignPreviewBlob(previewBlob, finalFileName);

      // E2E Encryption Flow when publicKey & WebCrypto are available
      const hasSubtleCrypto = typeof window !== 'undefined' && window.crypto && window.crypto.subtle;
      let e2eMetadata = null;
      if (publicKey && hasSubtleCrypto) {
        try {
          const rawKey = window.crypto.getRandomValues(new Uint8Array(32));
          const rawIv = window.crypto.getRandomValues(new Uint8Array(12));
          const cryptoKey = await window.crypto.subtle.importKey(
            'raw',
            rawKey,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
          );
          const arrayBufferToEncrypt = await previewBlob.arrayBuffer();
          const encryptedBuffer = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: rawIv },
            cryptoKey,
            arrayBufferToEncrypt
          );

          payloadToUpload = new Blob([encryptedBuffer], { type: 'application/octet-stream' });

          const forgePublicKey = forge.pki.publicKeyFromPem(publicKey);
          const rawKeyStr = Array.from(rawKey).map((b) => String.fromCharCode(b)).join('');
          const rawIvStr = Array.from(rawIv).map((b) => String.fromCharCode(b)).join('');

          const encryptedRawKey = forgePublicKey.encrypt(rawKeyStr, 'RSA-OAEP', {
            md: forge.md.sha256.create(),
            mgf1: { md: forge.md.sha256.create() },
          });

          const encryptedRawKeyB64 = forge.util.encode64(encryptedRawKey);
          const rawIvB64 = forge.util.encode64(rawIvStr);
          const rawKeyB64 = forge.util.encode64(rawKeyStr);

          setEncryptedKey(encryptedRawKeyB64);
          setIv(rawIvB64);
          isEncrypted = true;

          e2eMetadata = {
            isEncrypted: true,
            rawKey: rawKeyB64,
            rawIv: rawIvB64,
            encryptedKey: encryptedRawKeyB64,
            iv: rawIvB64,
          };
        } catch (encErr) {
          console.warn('E2E encryption failed, proceeding with direct upload:', encErr);
          isEncrypted = false;
        }
      }

      // -------------------------------------------------------
      //  PDF‑MIME COERCION (Windows Chrome)
      // -------------------------------------------------------
      // Chrome on Windows reports PDFs as `application/octet-stream`.
      // Multer only accepts the explicit PDF MIME types listed in upload.routes.js.
      // To keep the backend happy we override the MIME type for any file whose
      // extension is .pdf.
      let uploadBlob = payloadToUpload;
      if (/\.pdf$/i.test(finalFileName) && payloadToUpload.type === 'application/octet-stream') {
        // Create a new Blob with the correct MIME type.
        uploadBlob = new Blob([payloadToUpload], { type: 'application/pdf' });
      }
      const formData = new FormData();
      formData.append('file', uploadBlob, finalFileName);
      formData.append('isEncrypted', String(isEncrypted));
      formData.append('claimedPages', String(claimedPages));

      const response = await axios.post(`${API_URL}/api/upload`, formData, {
        headers: { ...authHeaders() },
      });

      if (response.data?.success) {
        const data = response.data.file;
        data.pages = isEncrypted || files.length > 1 || isSingleImage ? claimedPages : data.pages;
        data.originalName = finalFileName;
        setFileData(data);

        saveRecoveredSession(scopeParams, {
          fileData: data,
          e2e: e2eMetadata || { isEncrypted: false },
        });

        const currentSid = activeSessionId || sessionId;
        if (socket && currentSid) {
          socket.emit('file_uploaded', { sessionId: currentSid, fileData: data });
        }
        setStep(2);
      }
    } catch (err) {
      console.error('Mobile upload error:', err);
      const serverMsg = extractErrorMessage(err, 'Upload failed. Please try again.');
      if (err.code === 'ECONNABORTED' || (err.message && err.message.includes('timeout'))) {
        showError('Server is waking up, please try again in a few seconds.');
      } else {
        showError(serverMsg);
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePageRangeTypeSelect = (type) => {
    const totalPages = fileData?.pages || 1;
    if (type === 'all') {
      setRangeValidationError(null);
      setSettings((prev) => ({
        ...prev,
        pageRangeType: 'all',
        customRange: '',
        pagesToPrint: totalPages,
      }));
    } else {
      const res = parseCustomPageRange(settings.customRange, totalPages);
      setRangeValidationError(res.error);
      setSettings((prev) => ({
        ...prev,
        pageRangeType: 'custom',
        pagesToPrint: res.count > 0 ? res.count : totalPages,
      }));
    }
  };

  const handleCustomRangeInput = (e) => {
    const val = e.target.value;
    const totalPages = fileData?.pages || 1;
    const res = parseCustomPageRange(val, totalPages);
    setRangeValidationError(res.error);
    setSettings((prev) => ({
      ...prev,
      customRange: val,
      pagesToPrint: res.count > 0 ? res.count : totalPages,
    }));
  };

  const handlePrintSettingsSubmit = async () => {
    if (submitSettingsInFlightRef.current || isSubmittingSettings) return;
    if (settings.pageRangeType === 'custom' && rangeValidationError) {
      showError(rangeValidationError);
      return;
    }

    submitSettingsInFlightRef.current = true;
    setIsSubmittingSettings(true);
    setPaymentOutcome(null);
    setOrderId(null);

    try {
      const payload = { file: fileData, settings };
      if (encryptedKey && iv) {
        payload.encryptedKey = encryptedKey;
        payload.iv = iv;
      }

      const res = await axios.post(`${API_URL}/api/jobs`, payload, {
        timeout: 15000,
        headers: authHeaders(),
      });

      if (res.data?.success && res.data.job) {
        const createdJob = res.data.job;
        const serverCost = createdJob.cost;
        setJobId(createdJob.shortId);
        setPrice(serverCost);

        // Sync itemized breakdown from backend immutable pricingSnapshot when available
        let parsedBreakdown = null;
        try {
          const snap = typeof createdJob.pricingSnapshot === 'string'
            ? JSON.parse(createdJob.pricingSnapshot)
            : createdJob.pricingSnapshot;
          if (snap?.calculation) {
            parsedBreakdown = snap.calculation;
            setServerBreakdown(snap.calculation);
          }
        } catch {
          // ignore snapshot parse issues; liveBreakdown remains accurate fallback
        }

        if (createdJob.paymentMode) {
          setPaymentMode(createdJob.paymentMode);
        }

        saveRecoveredSession(scopeParams, {
          jobId: createdJob.shortId,
          orderId: null,
          price: serverCost,
          pricingBreakdown: parsedBreakdown,
          fileData,
          settings,
          paymentMode: createdJob.paymentMode || paymentMode,
          paymentState: 'READY',
        });

        const currentSid = activeSessionId || sessionId;
        if (socket && currentSid) {
          socket.emit('payment_initiated', {
            sessionId: currentSid,
            price: serverCost,
            jobId: createdJob.shortId,
          });
        }
        setStep(3);
      }
    } catch (err) {
      console.error('Job creation error:', err);
      if (err.code === 'ECONNABORTED' || (err.message && err.message.includes('timeout'))) {
        showError('Server is waking up, please try again in a few seconds.');
      } else {
        showError(extractErrorMessage(err, 'Failed to save print settings. Please try again.'));
      }
    } finally {
      setIsSubmittingSettings(false);
      submitSettingsInFlightRef.current = false;
    }
  };

  // Official Cashfree v3 Sandbox Checkout Flow (NEVER dispatches without server verification)
  const handleCashfreeCheckout = async () => {
    if (!jobId) {
      showError('Missing Print Job ID. Please confirm your print settings again.');
      return;
    }
    if (checkoutInFlightRef.current || isInitializingPayment) {
      return;
    }

    checkoutInFlightRef.current = true;
    setIsInitializingPayment(true);
    setPaymentOutcome(null);

    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
      const returnUrl = `${origin}${pathname}?job_id=${encodeURIComponent(jobId)}&order_id={order_id}`;

      const orderRes = await axios.post(
        `${API_URL}/api/payments/order/${encodeURIComponent(jobId)}`,
        {
          sessionId: activeSessionId || sessionId,
          returnUrl,
        },
        { headers: authHeaders() }
      );

      if (!orderRes.data?.success || !orderRes.data?.paymentSessionId) {
        throw new Error(orderRes.data?.error || 'Failed to initialize Cashfree payment order.');
      }

      const {
        paymentSessionId,
        orderId: createdOrderId,
        environment,
      } = orderRes.data;

      const resolvedMode = normalizeCashfreeMode(environment || cashfreeEnv);
      setCashfreeEnv(resolvedMode);
      setOrderId(createdOrderId);

      saveRecoveredSession(scopeParams, {
        jobId,
        orderId: createdOrderId,
        cashfreeEnv: resolvedMode,
        paymentState: 'CHECKOUT_OPENED',
      });

      const sdkResult = await launchCashfreeCheckout({
        paymentSessionId,
        orderId: createdOrderId,
        environment: resolvedMode,
        returnUrl,
        redirectTarget: '_modal',
      });

      if (sdkResult.outcome === 'REDIRECTED') {
        setIsVerifyingPayment(true);
        return;
      }

      // Whether modal succeeded, errored, or closed: ALWAYS verify authoritatively on backend!
      setIsVerifyingPayment(true);
      const verification = await verifyPaymentStatus(createdOrderId, sessionToken);
      if (!verification.verified && sdkResult.outcome === 'FAILED_OR_CANCELLED') {
        setPaymentOutcome({
          type: 'FAILED',
          message: sdkResult.message || 'Payment failed or was cancelled at Cashfree.',
        });
      } else if (!verification.verified && sdkResult.outcome === 'DISMISSED_OR_UNKNOWN' && verification.status === 'PENDING') {
        setPaymentOutcome({
          type: 'DROPPED',
          message: 'Payment window closed before confirmation. Tap Retry Payment or Check Status.',
        });
      }
    } catch (err) {
      console.error('Cashfree checkout error:', err);
      const msg = extractErrorMessage(err, 'Unable to start Cashfree payment.');
      setPaymentOutcome({
        type: 'FAILED',
        message: msg,
      });
      showError(msg);
    } finally {
      setIsInitializingPayment(false);
      checkoutInFlightRef.current = false;
    }
  };

  // Simulated Staging Demo Payment Flow (Produces real physical print on Staging Epson printer)
  const handleDemoPayment = async () => {
    if (!jobId) {
      showError('Missing Print Job ID. Please confirm your print settings again.');
      return;
    }
    const trimmedCode = (demoAccessCode || '').trim();
    if (demoAccessCodeRequired && !trimmedCode) {
      showError('Demo access code is required for simulated physical printing.');
      return;
    }
    if (demoPayInFlightRef.current || isExecutingDemoPay || isInitializingPayment || isVerifyingPayment) {
      return;
    }

    demoPayInFlightRef.current = true;
    setIsExecutingDemoPay(true);
    setPaymentOutcome(null);

    try {
      const res = await axios.post(
        `${API_URL}/api/payments/demo-pay/${encodeURIComponent(jobId)}`,
        demoAccessCodeRequired ? { accessCode: trimmedCode } : {},
        { headers: authHeaders() }
      );

      if (res.data?.success && res.data?.job) {
        const returnedJob = res.data.job;
        setJobId(returnedJob.shortId);
        setJobStatus(returnedJob.status || 'WAITING');

        if (res.data.dispatched === false) {
          setDispatchWarning(
            res.data.message || 'Demo payment confirmed, but print queue dispatch encountered an error. Please notify the counter operator to release your print job.'
          );
        } else {
          setDispatchWarning(null);
        }

        setStep(4);
        // Note: demoAccessCode is strictly NEVER persisted to localStorage or sessionStorage
        saveRecoveredSession(scopeParams, {
          jobId: returnedJob.shortId,
          orderId: res.data.payment?.gatewayOrderId || `demo_order_${returnedJob.shortId}`,
          paymentState: 'PAID',
        });
      } else {
        throw new Error(res.data?.error || 'Demo payment failed.');
      }
    } catch (err) {
      console.error('Demo payment error:', err);
      const msg = extractErrorMessage(err, 'Failed to complete simulated demo payment.');
      setPaymentOutcome({
        type: 'FAILED',
        message: msg,
      });
      showError(msg);
    } finally {
      setDemoAccessCode(''); // Always clear access code after use
      setIsExecutingDemoPay(false);
      demoPayInFlightRef.current = false;
    }
  };

  // Download Customer Receipt / Tax Invoice PDF cleanly via authenticated Blob fetch
  const handleDownloadCustomerReceipt = async () => {
    if (!jobId || downloadingReceipt) return;
    setDownloadingReceipt(true);
    try {
      const response = await axios.get(
        `${API_URL}/api/jobs/${encodeURIComponent(jobId)}/invoice/download`,
        { responseType: 'blob', headers: authHeaders() }
      );
      const pdfBlob = new Blob([response.data], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${invoiceData?.invoiceNumber || `S3K_Receipt_${jobId}`}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      showError(extractErrorMessage(err, 'Receipt PDF is not ready yet. Please try again in a moment.'));
    } finally {
      setDownloadingReceipt(false);
    }
  };

  const effectivePreviewUrl =
    previewUrl ||
    (fileData?.filename
      ? `${API_URL}/api/upload/preview/${encodeURIComponent(fileData.filename.split('/').pop())}`
      : null);

  const displayedTotal = step >= 3 && price > 0 ? price : liveBreakdown.totalAmount;
  const displayedBreakdown = step >= 3 && serverBreakdown ? serverBreakdown : liveBreakdown;
  const activeDuplexRate =
    settings.color === 'color' ? pricingProfile.colorDuplexRate : pricingProfile.bwDuplexRate;

  const renderS3KHeader = () => (
    <header className="s3k-header animate-fade-in">
      <div className="s3k-brand-badge">
        <div className="s3k-logo-box">S3K</div>
        <div className="s3k-brand-text">
          <span className="s3k-presents">S3K PRESENTS</span>
          <span className="s3k-brand-title">
            Print <span className="s3k-brand-gold">Yourself</span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div
          className="s3k-status-pill"
          title={printerInfo?.name ? `${printerInfo.name} (${customerStatusText})` : customerStatusText}
          style={{
            borderColor: isPrinterReady
              ? 'rgba(52, 211, 153, 0.4)'
              : (isAgentOffline ? 'rgba(251, 191, 36, 0.4)' : 'rgba(239, 68, 68, 0.4)')
          }}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isPrinterReady
                ? 'bg-emerald-400 animate-pulse'
                : (isAgentOffline ? 'bg-amber-400' : (isPrinterDisconnected ? 'bg-red-400' : 'bg-slate-400'))
            }`}
          />
          <span>{customerStatusText}</span>
        </div>
      </div>
    </header>
  );

  const renderStep = () => {
    if (qrError) {
      return (
        <div className="s3k-card s3k-card-gold text-center py-6 px-4 animate-scale-in" style={{ margin: 'auto 0' }}>
          <div
            style={{
              display: 'inline-flex',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1.5px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '50%',
              padding: '1rem',
              marginBottom: '0.75rem',
            }}
          >
            <AlertTriangle size={36} style={{ color: '#EF4444' }} />
          </div>
          <h2 className="text-lg font-bold mb-1 text-white">{qrError.title}</h2>
          <p className="text-slate-300 text-xs max-w-xs mx-auto mb-5 leading-relaxed">
            {typeof qrError.message === 'string' ? qrError.message : String(qrError.message || '')}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="s3k-primary-btn mx-auto"
            style={{ maxWidth: 220 }}
          >
            <RefreshCw size={15} /> Scan Again
          </button>
        </div>
      );
    }

    switch (step) {
      case 1:
        return (
          <div className="flex flex-col justify-center animate-fade-in" style={{ gap: '0.65rem' }}>
            <AdvertisementDisplay
              sessionToken={sessionToken}
              publicCode={publicCode}
              placement="MOBILE_ONLY"
            />

            <div className="s3k-card py-2 px-3 flex items-center justify-between" style={{ minHeight: 48 }}>
              <div className="flex items-center gap-2.5 overflow-hidden flex-1 min-w-0 mr-2">
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: isPrinterReady ? 'rgba(30, 64, 175, 0.35)' : 'rgba(239, 68, 68, 0.15)',
                    border: isPrinterReady ? '1px solid rgba(212, 175, 55, 0.35)' : '1px solid rgba(239, 68, 68, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: isPrinterReady ? '#D4AF37' : '#EF4444',
                    flexShrink: 0,
                  }}
                >
                  <Printer size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white truncate leading-tight">
                    {printerInfo?.name || 'Counter Printer'}
                  </p>
                  <p className="text-[10.5px] text-slate-300 truncate mt-0.5 leading-none">
                    {printerInfo?.location || 'Counter Terminal'} • {customerStatusText}
                    {printerInfo?.lastTelemetryAt && ` • Freshness: ${new Date(printerInfo.lastTelemetryAt).toLocaleTimeString()}`}
                  </p>
                </div>
              </div>
              <div className="flex-shrink-0">
                <span
                  style={{
                    whiteSpace: 'nowrap',
                    padding: '0.2rem 0.55rem',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    color: isPrinterReady ? '#34D399' : (isAgentOffline ? '#FBBF24' : '#EF4444'),
                    background: isPrinterReady ? 'rgba(16, 185, 129, 0.12)' : (isAgentOffline ? 'rgba(245, 158, 11, 0.12)' : 'rgba(239, 68, 68, 0.12)'),
                    border: `1px solid ${isPrinterReady ? 'rgba(16, 185, 129, 0.3)' : (isAgentOffline ? 'rgba(245, 158, 11, 0.3)' : 'rgba(239, 68, 68, 0.3)')}`,
                    borderRadius: '9999px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: isPrinterReady ? '#10B981' : (isAgentOffline ? '#F59E0B' : '#EF4444'), display: 'inline-block' }} />
                  {isPrinterReady ? 'Ready' : (isAgentOffline ? 'Offline' : (isPrinterDisconnected ? 'Disconnected' : 'Unavailable'))}
                </span>
              </div>
            </div>

            {!isPrinterReady && (
              <div
                className="s3k-card text-center py-3 px-3 animate-fade-in"
                style={{
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: 12,
                }}
              >
                <div className="flex items-center justify-center gap-1.5 mb-1 text-amber-400 font-bold text-xs">
                  <AlertTriangle size={15} />
                  <span>{customerStatusText}</span>
                </div>
                <p className="text-slate-300 text-[11px] leading-relaxed mb-2.5">
                  The printer at this counter is currently unavailable. File uploads and payments are temporarily paused.
                </p>
                <button
                  type="button"
                  onClick={handleRefreshPrinterStatus}
                  disabled={isRefreshingStatus}
                  className="btn text-xs py-1 px-3 mx-auto"
                  style={{
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    color: '#FFFFFF',
                    borderRadius: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                  }}
                >
                  <RefreshCw size={12} className={isRefreshingStatus ? 'animate-spin' : ''} />
                  Refresh Status
                </button>
              </div>
            )}

            <div
              className="s3k-upload-dropzone"
              style={!isPrinterReady ? { opacity: 0.55 } : {}}
            >
              <div
                style={{
                  width: 62,
                  height: 62,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(30,64,175,0.45) 0%, rgba(15,23,42,0.85) 100%)',
                  border: '1.5px solid rgba(212, 175, 55, 0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 18px rgba(212, 175, 55, 0.3)',
                  marginBottom: '0.85rem',
                }}
              >
                <Upload size={30} style={{ color: '#F59E0B' }} className={uploading ? 'animate-bounce' : ''} />
              </div>

              <h2 className="text-lg font-extrabold text-white mb-1 tracking-tight">Upload Your Document</h2>
              <p className="text-slate-300 text-xs mb-4">Select PDF or photo files from your phone</p>

              {uploading ? (
                <div className="w-full max-w-xs mx-auto animate-scale-in">
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-2 relative border border-slate-700">
                    <div
                      className="absolute top-0 left-0 h-full rounded-full animate-[pulse_1.5s_ease-in-out_infinite]"
                      style={{ width: '85%', background: 'linear-gradient(90deg, #F59E0B, #2563EB)' }}
                    />
                  </div>
                  <p className="text-xs font-semibold text-amber-400">Preparing & securing document...</p>
                </div>
              ) : fileData ? (
                <div className="w-full max-w-xs mx-auto flex flex-col gap-2">
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-amber-400/30 flex items-center justify-between text-left">
                    <div className="min-w-0 flex-1 mr-2">
                      <p className="text-xs font-bold text-white truncate">{fileData.originalName || 'Uploaded File'}</p>
                      <p className="text-[10.5px] text-amber-400 font-semibold">
                        {fileData.pages || 1} {fileData.pages === 1 ? 'page' : 'pages'} ready
                      </p>
                    </div>
                    <label className="text-[11px] font-bold text-slate-300 hover:text-white px-2.5 py-1 rounded bg-slate-800 border border-slate-700 cursor-pointer flex-shrink-0">
                      Change
                      <input
                        type="file"
                        multiple
                        accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                        disabled={uploading}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className="s3k-primary-btn s3k-gold-btn w-full"
                    style={{ minHeight: '42px', fontSize: '0.9rem' }}
                  >
                    <span>Continue to Print Settings</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              ) : (
                <label
                  className={`s3k-primary-btn s3k-gold-btn max-w-xs mx-auto ${!isPrinterReady ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  style={!isPrinterReady ? { pointerEvents: 'none' } : {}}
                >
                  <Upload size={18} />
                  Choose Files to Print
                  <input
                    type="file"
                    multiple
                    accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleFileUpload}
                    disabled={uploading || !isPrinterReady}
                  />
                </label>
              )}

              {!uploading && (
                <div className="s3k-format-grid">
                  <span className="s3k-format-badge">📄 PDF Document</span>
                  <span className="s3k-format-badge">🖼️ PNG / JPG / WEBP</span>
                  <span className="s3k-format-badge">🔒 E2E Encrypted</span>
                  <span className="s3k-format-badge">⚡ Max 50MB</span>
                </div>
              )}
            </div>
          </div>
        );

      case 2:
        return (
          <div className="flex flex-col justify-center animate-fade-in" style={{ gap: '0.45rem' }}>
            <AdvertisementDisplay
              sessionToken={sessionToken}
              publicCode={publicCode}
              placement="MOBILE_ONLY"
            />

            <div className="s3k-card py-2 px-3 flex items-center justify-between">
              <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 6,
                    background: 'rgba(30,64,175,0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#60A5FA',
                    flexShrink: 0,
                  }}
                >
                  <FileText size={16} />
                </div>
                <div className="overflow-hidden min-w-0">
                  <p className="text-xs font-bold text-white truncate max-w-[140px] leading-tight">
                    {fileData?.originalName || 'Uploaded Document'}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate mt-0.5 leading-none">
                    {fileData?.size ? `${Math.round(fileData.size / 1024)} KB • ` : ''}
                    {fileData?.pages || 1} {fileData?.pages === 1 ? 'Page' : 'Pages'} detected
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10.5px] font-bold px-2 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/30">
                  {fileData?.pages || 1} {fileData?.pages === 1 ? 'Page' : 'Pages'}
                </span>
                <button
                  type="button"
                  onClick={() => setIsPreviewOpen(true)}
                  className="s3k-preview-btn"
                  title="Preview Document"
                >
                  <Eye size={13} />
                  <span>Preview</span>
                </button>
              </div>
            </div>

            <div className="s3k-card py-2.5 px-3 flex flex-col" style={{ gap: '0.45rem' }}>
              <div>
                <label className="text-[11px] font-bold text-slate-300 block mb-1">Color Mode</label>
                <div className="s3k-option-grid">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`s3k-option-btn ${settings.color === 'bw' ? 'selected' : ''}`}
                    onClick={() => setSettings((p) => ({ ...p, color: 'bw' }))}
                    onKeyDown={(e) => e.key === 'Enter' && setSettings((p) => ({ ...p, color: 'bw' }))}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-xs font-bold text-white">Black & White</p>
                        <p className="text-[10px] text-amber-400">₹{pricingProfile.bwSingleRate} / page</p>
                      </div>
                      {settings.color === 'bw' && <Check size={14} className="text-amber-400" />}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`s3k-option-btn ${settings.color === 'color' ? 'selected' : ''}`}
                    onClick={() => setSettings((p) => ({ ...p, color: 'color' }))}
                    onKeyDown={(e) => e.key === 'Enter' && setSettings((p) => ({ ...p, color: 'color' }))}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-xs font-bold text-white">Full Color</p>
                        <p className="text-[10px] text-amber-400">₹{pricingProfile.colorSingleRate} / page</p>
                      </div>
                      {settings.color === 'color' && <Check size={14} className="text-amber-400" />}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-300 block mb-1">Sides</label>
                <div className="s3k-option-grid">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`s3k-option-btn ${settings.duplex === 'single' ? 'selected' : ''}`}
                    onClick={() => setSettings((p) => ({ ...p, duplex: 'single' }))}
                    onKeyDown={(e) => e.key === 'Enter' && setSettings((p) => ({ ...p, duplex: 'single' }))}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-xs font-bold text-white">Single Sided</p>
                        <p className="text-[10px] text-slate-400">1 side/sheet</p>
                      </div>
                      {settings.duplex === 'single' && <Check size={14} className="text-amber-400" />}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`s3k-option-btn ${settings.duplex === 'double' ? 'selected' : ''}`}
                    onClick={() => setSettings((p) => ({ ...p, duplex: 'double' }))}
                    onKeyDown={(e) => e.key === 'Enter' && setSettings((p) => ({ ...p, duplex: 'double' }))}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-xs font-bold text-white">Double Sided</p>
                        <p className="text-[10px] text-amber-400">₹{activeDuplexRate} / sheet</p>
                      </div>
                      {settings.duplex === 'double' && <Check size={14} className="text-amber-400" />}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    borderRadius: '10px',
                    padding: '0.35rem 0.5rem',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                  }}
                >
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#94A3B8', textAlign: 'center', marginBottom: '0.2rem' }}>
                    Copies
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0.2rem' }}>
                    <button
                      type="button"
                      className="s3k-stepper-btn"
                      onClick={() => setSettings((p) => ({ ...p, copies: Math.max(1, p.copies - 1) }))}
                    >
                      −
                    </button>
                    <span style={{ fontSize: '1rem', fontWeight: 900, color: '#FFFFFF' }}>{settings.copies}</span>
                    <button
                      type="button"
                      className="s3k-stepper-btn"
                      onClick={() => setSettings((p) => ({ ...p, copies: Math.min(100, p.copies + 1) }))}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    borderRadius: '10px',
                    padding: '0.35rem 0.5rem',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2rem', padding: '0 0.1rem' }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#94A3B8' }}>Pages</span>
                    <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#F59E0B' }}>
                      {settings.pagesToPrint} {settings.pagesToPrint === 1 ? 'page' : 'pages'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem' }}>
                    <button
                      type="button"
                      className={`s3k-page-btn ${settings.pageRangeType === 'all' ? 'active' : ''}`}
                      onClick={() => handlePageRangeTypeSelect('all')}
                    >
                      All ({fileData?.pages || 1})
                    </button>
                    <button
                      type="button"
                      className={`s3k-page-btn ${settings.pageRangeType === 'custom' ? 'active' : ''}`}
                      onClick={() => handlePageRangeTypeSelect('custom')}
                    >
                      Custom
                    </button>
                  </div>
                </div>
              </div>

              {settings.pageRangeType === 'custom' && (
                <div className="animate-slide-up" style={{ marginTop: '0.2rem' }}>
                  <input
                    type="text"
                    name="customRange"
                    placeholder="e.g. 1-3, 2,4,6"
                    style={{
                      width: '100%',
                      background: '#090D1A',
                      color: '#F8FAFC',
                      border: '1px solid rgba(245, 158, 11, 0.7)',
                      borderRadius: '8px',
                      padding: '0.35rem 0.6rem',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      outline: 'none',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
                    }}
                    value={settings.customRange || ''}
                    onChange={handleCustomRangeInput}
                  />
                  {rangeValidationError && (
                    <p className="text-[10px] text-red-400 mt-1 pl-1 leading-tight">{rangeValidationError}</p>
                  )}
                  {!rangeValidationError && settings.customRange && (
                    <p className="text-[10px] text-amber-400 mt-0.5 pl-1 leading-tight">
                      Selected: {settings.pagesToPrint} of {fileData?.pages || 1} pages
                    </p>
                  )}
                </div>
              )}

              {/* Compact Pricing Breakdown */}
              <div className="bg-slate-900/60 border border-slate-700/70 rounded-lg px-2.5 py-1.5 text-[10.5px] text-slate-300 flex flex-col gap-0.5">
                <div className="flex justify-between">
                  <span>{liveBreakdown.rateLabel} × {liveBreakdown.sheetsCount} sheet{liveBreakdown.sheetsCount === 1 ? '' : 's'}</span>
                  <span className="font-semibold text-white">₹{liveBreakdown.basePrintCharge.toFixed(2)}</span>
                </div>
                {liveBreakdown.convenienceFee > 0 && (
                  <div className="flex justify-between">
                    <span>Platform Fee</span>
                    <span>₹{liveBreakdown.convenienceFee.toFixed(2)}</span>
                  </div>
                )}
                {liveBreakdown.minOrderAdjustment > 0 && (
                  <div className="flex justify-between">
                    <span>Min. Order Adjustment</span>
                    <span>₹{liveBreakdown.minOrderAdjustment.toFixed(2)}</span>
                  </div>
                )}
                {liveBreakdown.gstEnabled && liveBreakdown.totalTax > 0 && (
                  <div className="flex justify-between">
                    <span>GST ({liveBreakdown.gstRatePercent}% {liveBreakdown.isTaxInclusive ? 'Incl.' : 'Excl.'})</span>
                    <span>₹{liveBreakdown.totalTax.toFixed(2)}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="s3k-card s3k-card-gold py-3 px-3.5 flex items-center justify-between gap-3">
              <div className="flex-shrink-0 min-w-0">
                <p className="text-[11px] font-extrabold text-amber-400 uppercase tracking-wider leading-none">
                  Total Amount
                </p>
                <p className="text-2xl sm:text-3xl font-black text-white leading-none mt-1">
                  ₹{liveBreakdown.totalAmount.toFixed(2)}
                </p>
              </div>

              <button
                type="button"
                className="s3k-primary-btn s3k-gold-btn"
                style={{
                  width: 'auto',
                  minHeight: '46px',
                  padding: '0.75rem 1.4rem',
                  fontSize: '0.98rem',
                  fontWeight: 900,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                onClick={handlePrintSettingsSubmit}
                disabled={isSubmittingSettings}
              >
                {isSubmittingSettings ? (
                  <>
                    <Loader size={18} className="animate-spin" /> Saving...
                  </>
                ) : (
                  <>
                    Proceed to Payment <ChevronRight size={18} />
                  </>
                )}
              </button>
            </div>

            <div className="flex justify-center mt-0.5">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="s3k-back-btn"
                title="Return to document upload"
              >
                <ChevronLeft size={13} className="text-amber-400" />
                <span>Back to Document Upload</span>
              </button>
            </div>
          </div>
        );

      case 3:
        if (isVerifyingPayment) {
          return (
            <div className="s3k-card s3k-card-gold text-center py-7 px-4 animate-scale-in" style={{ margin: 'auto 0' }}>
              <div
                style={{
                  display: 'inline-flex',
                  background: 'rgba(30, 64, 175, 0.35)',
                  border: '1.5px solid rgba(212, 175, 55, 0.4)',
                  borderRadius: '50%',
                  padding: '1.25rem',
                  marginBottom: '1rem',
                  boxShadow: '0 0 16px rgba(212, 175, 55, 0.25)',
                }}
              >
                <Loader size={38} className="animate-spin text-amber-400" />
              </div>
              <h2 className="text-xl font-extrabold text-white mb-1">Verifying Payment</h2>
              <p className="text-xs text-slate-300 mb-4 font-medium">
                Confirming payment status with Cashfree & backend server...
              </p>

              <div className="w-full max-w-xs mx-auto bg-slate-900 rounded-full h-2 mb-5 overflow-hidden border border-slate-700">
                <div
                  className="h-full rounded-full animate-pulse"
                  style={{ width: '80%', background: 'linear-gradient(90deg, #F59E0B, #2563EB)' }}
                />
              </div>

              <button
                type="button"
                className="text-xs text-slate-400 hover:text-white underline cursor-pointer"
                onClick={() => setIsVerifyingPayment(false)}
              >
                ← Return to Payment Options
              </button>
            </div>
          );
        }

        // CASH AT COUNTER MODE: Simplified 1-screen customer experience
        if (paymentMode === 'CASH_AT_COUNTER') {
          return (
            <div className="flex flex-col justify-center animate-scale-in" style={{ gap: '0.65rem' }}>
              <div className="s3k-card s3k-card-gold text-center py-5 px-4 flex flex-col items-center justify-center">
                <div
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.3) 0%, rgba(15,23,42,0.8) 100%)',
                    border: '1.5px solid rgba(16, 185, 129, 0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 0 16px rgba(16, 185, 129, 0.25)',
                    marginBottom: '0.75rem',
                  }}
                >
                  <Banknote size={32} style={{ color: '#10B981' }} />
                </div>

                <h2 className="text-xl font-black text-white mb-1">Pay at Counter</h2>

                <div className="w-full bg-slate-900/90 border border-emerald-500/30 rounded-xl p-3.5 text-left mb-3">
                  <p className="text-xs text-slate-200 leading-relaxed font-medium">
                    Your print order is ready.<br />
                    Show your Order ID to the cashier and pay the exact amount in cash.<br />
                    Printing will start after the cashier confirms payment.
                  </p>
                </div>

                {/* Prominent Order ID Box */}
                <div className="w-full bg-slate-950/80 border border-amber-400/40 rounded-xl p-3 text-center mb-3">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                    Order ID
                  </span>
                  <div className="text-2xl font-black text-amber-400 tracking-wider">
                    #{jobId}
                  </div>
                </div>

                {/* Authoritative Order Summary */}
                <div className="w-full bg-slate-900/70 border border-slate-700/80 rounded-xl p-3 text-left mb-3">
                  <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                    <span>Document</span>
                    <span className="font-bold text-white truncate max-w-[170px]">{fileData?.originalName || 'Document'}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                    <span>Pages & Copies</span>
                    <span className="font-bold text-white">
                      {settings.pagesToPrint} {settings.pagesToPrint === 1 ? 'Page' : 'Pages'} × {settings.copies}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                    <span>Print Mode</span>
                    <span className="font-bold text-white">
                      {settings.color === 'color' ? 'Full Color' : 'Black & White'} •{' '}
                      {settings.duplex === 'double' ? 'Double Sided' : 'Single Sided'}
                    </span>
                  </div>
                  {displayedBreakdown?.convenienceFee > 0 && (
                    <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                      <span>Convenience Fee</span>
                      <span>₹{Number(displayedBreakdown.convenienceFee).toFixed(2)}</span>
                    </div>
                  )}
                  {displayedBreakdown?.gstEnabled && displayedBreakdown?.totalTax > 0 && (
                    <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                      <span>GST ({displayedBreakdown.gstRatePercent}%)</span>
                      <span>₹{Number(displayedBreakdown.totalTax).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="border-t border-slate-700/80 pt-2 flex justify-between items-center">
                    <span className="text-xs font-bold text-amber-400">Total Payable in Cash</span>
                    <span className="text-xl font-black text-emerald-400">₹{Number(displayedTotal).toFixed(2)}</span>
                  </div>
                </div>

                {/* Live Real-time Status Notice */}
                <div className="w-full bg-emerald-950/30 border border-emerald-500/30 rounded-xl px-3 py-2.5 text-center mb-2 flex items-center justify-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-xs font-bold text-emerald-300">
                    Awaiting Cashier Confirmation...
                  </span>
                </div>

                <p className="text-[11px] text-slate-400 text-center mb-1">
                  Please show this screen to the counter staff. Printing starts automatically once confirmed.
                </p>

                <button
                  type="button"
                  onClick={() => {
                    setPaymentOutcome(null);
                    setStep(2);
                  }}
                  className="s3k-back-btn mt-2"
                >
                  <ChevronLeft size={13} className="text-amber-400" />
                  <span>Modify Print Settings</span>
                </button>
              </div>
            </div>
          );
        }

        return (
          <div className="flex flex-col justify-center animate-scale-in" style={{ gap: '0.65rem' }}>
            <div className="s3k-card s3k-card-gold text-center py-4 px-4 flex flex-col items-center justify-center">
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(30,64,175,0.4) 0%, rgba(15,23,42,0.8) 100%)',
                  border: '1.5px solid rgba(212, 175, 55, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 16px rgba(212, 175, 55, 0.3)',
                  marginBottom: '0.65rem',
                }}
              >
                <ShieldCheck size={30} style={{ color: '#D4AF37' }} />
              </div>

              <h2 className="text-xl font-black text-white mb-1">Cashfree Checkout</h2>
              <p className="text-xs text-slate-300 mb-2">
                Job ID: <strong className="text-amber-400">{jobId}</strong>
                {orderId && (
                  <span className="ml-2 text-slate-400">
                    • Order: <strong className="text-slate-200">{orderId}</strong>
                  </span>
                )}
              </p>

              {/* Environment Indicator Banner */}
              <div
                className="w-full rounded-xl px-3 py-1.5 text-left mb-2.5 flex items-center justify-between gap-2"
                style={{
                  background: cashfreeEnv === 'sandbox' ? 'rgba(245, 158, 11, 0.14)' : 'rgba(16, 185, 129, 0.14)',
                  border: cashfreeEnv === 'sandbox' ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid rgba(16, 185, 129, 0.35)',
                }}
              >
                <span className={`text-[11px] font-bold whitespace-nowrap ${cashfreeEnv === 'sandbox' ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {cashfreeEnv === 'sandbox' ? 'Cashfree Sandbox Test Mode' : 'Cashfree Verified Checkout'}
                </span>
                <span className="text-[10px] text-slate-300 font-semibold whitespace-nowrap">UPI / Cards / NetBanking</span>
              </div>

              {/* Payment Outcome Error / Pending Banner */}
              {paymentOutcome && (
                <div className="w-full bg-red-950/40 border border-red-500/40 rounded-xl px-3 py-2 text-left mb-2.5">
                  <p className="text-xs font-bold text-red-300 flex items-center gap-1.5">
                    <AlertTriangle size={14} />
                    <span>
                      {paymentOutcome.type === 'CANCELLED'
                        ? 'Payment Cancelled'
                        : paymentOutcome.type === 'DROPPED'
                          ? 'Checkout Closed'
                          : paymentOutcome.type === 'PENDING'
                            ? 'Verification Pending'
                            : paymentOutcome.type === 'MISMATCH'
                              ? 'Payment Amount Mismatch'
                              : 'Payment Failed'}
                    </span>
                  </p>
                  <p className="text-[11px] text-red-200/90 mt-0.5 leading-snug">{paymentOutcome.message}</p>
                </div>
              )}

              {/* Authoritative Order Summary */}
              <div className="w-full bg-slate-900/70 border border-slate-700/80 rounded-xl p-3 text-left mb-3">
                <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                  <span>Document</span>
                  <span className="font-bold text-white truncate max-w-[170px]">{fileData?.originalName || 'Document'}</span>
                </div>
                <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                  <span>Pages & Copies</span>
                  <span className="font-bold text-white">
                    {settings.pagesToPrint} {settings.pagesToPrint === 1 ? 'Page' : 'Pages'} × {settings.copies}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                  <span>Print Mode</span>
                  <span className="font-bold text-white">
                    {settings.color === 'color' ? 'Full Color' : 'Black & White'} •{' '}
                    {settings.duplex === 'double' ? 'Double Sided' : 'Single Sided'}
                  </span>
                </div>
                {displayedBreakdown?.convenienceFee > 0 && (
                  <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                    <span>Convenience Fee</span>
                    <span>₹{Number(displayedBreakdown.convenienceFee).toFixed(2)}</span>
                  </div>
                )}
                {displayedBreakdown?.gstEnabled && displayedBreakdown?.totalTax > 0 && (
                  <div className="flex justify-between items-center text-xs text-slate-300 mb-1.5">
                    <span>GST ({displayedBreakdown.gstRatePercent}%)</span>
                    <span>₹{Number(displayedBreakdown.totalTax).toFixed(2)}</span>
                  </div>
                )}
                <div className="border-t border-slate-700/80 pt-2 flex justify-between items-center">
                  <span className="text-xs font-bold text-amber-400">Total Payable</span>
                  <span className="text-xl font-black text-white">₹{Number(displayedTotal).toFixed(2)}</span>
                </div>
              </div>

              <button
                type="button"
                className="s3k-primary-btn s3k-gold-btn text-base py-3.5 w-full"
                onClick={handleCashfreeCheckout}
                disabled={isInitializingPayment || isVerifyingPayment || !isPrinterReady}
                style={!isPrinterReady ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
              >
                {!isPrinterReady ? (
                  <>
                    <AlertTriangle size={18} /> Printer Offline — Payment Paused
                  </>
                ) : isInitializingPayment ? (
                  <>
                    <Loader size={20} className="animate-spin" /> Opening Cashfree Checkout...
                  </>
                ) : (
                  <>
                    <CreditCard size={18} />{' '}
                    {paymentOutcome
                      ? `Retry Payment (₹${Number(displayedTotal).toFixed(2)})`
                      : `Pay ₹${Number(displayedTotal).toFixed(2)} via Cashfree`}
                  </>
                )}
              </button>

              {!isPrinterReady && (
                <div className="mt-2.5 text-center">
                  <p className="text-[11px] text-amber-400 font-semibold mb-1">
                    ⚠️ {customerStatusText}. Payment is paused until the printer is online.
                  </p>
                  <button
                    type="button"
                    onClick={handleRefreshPrinterStatus}
                    disabled={isRefreshingStatus}
                    className="text-[11px] text-slate-300 underline inline-flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw size={11} className={isRefreshingStatus ? 'animate-spin' : ''} /> Check Printer Status
                  </button>
                </div>
              )}

              {orderId && (
                <button
                  type="button"
                  onClick={() => {
                    setIsVerifyingPayment(true);
                    verifyPaymentStatus(orderId, sessionToken);
                  }}
                  className="mt-2.5 text-xs font-semibold text-amber-300 hover:text-amber-200 underline flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw size={12} /> Already paid? Check server status
                </button>
              )}

              {/* Staging-Only Simulated Demo Payment Section */}
              {enableDemoPayment && (
                <div className="w-full mt-4 pt-4 border-t border-slate-700/80">
                  <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 text-left mb-2.5">
                    <div className="flex items-center gap-1.5 text-amber-400 font-bold text-xs uppercase tracking-wider mb-1">
                      <Sparkles size={14} />
                      <span>Staging Simulation Warning</span>
                    </div>
                    <p className="text-[11px] text-amber-200/90 font-semibold leading-relaxed">
                      NO REAL PAYMENT WILL BE CHARGED.<br />
                      A REAL PHYSICAL PRINT WILL BE PRODUCED.
                    </p>
                  </div>

                  {demoAccessCodeRequired ? (
                    <div className="mb-3 text-left">
                      <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                        <Lock size={12} className="text-amber-400" />
                        <span>Supervised Demo Access Code</span>
                      </label>
                      <input
                        type="password"
                        value={demoAccessCode}
                        onChange={(e) => setDemoAccessCode(e.target.value)}
                        placeholder="Enter demo access code"
                        autoComplete="off"
                        disabled={isInitializingPayment || isVerifyingPayment || isExecutingDemoPay}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
                      />
                    </div>
                  ) : (
                    <p className="mb-3 text-xs text-emerald-200 text-left">
                      Access code is disabled for this Staging demo. Press the button below to run the simulation and dispatch the real print.
                    </p>
                  )}

                  <button
                    type="button"
                    className="s3k-primary-btn bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-950 font-black text-sm py-3.5 w-full shadow-lg transition-all flex items-center justify-center gap-2"
                    onClick={handleDemoPayment}
                    disabled={isInitializingPayment || isVerifyingPayment || isExecutingDemoPay || (demoAccessCodeRequired && !demoAccessCode.trim())}
                  >
                    {isExecutingDemoPay ? (
                      <>
                        <Loader size={18} className="animate-spin" /> Authorizing & Dispatching Print...
                      </>
                    ) : (
                      <>
                        <Zap size={16} /> SIMULATE DEMO PAYMENT — STAGING ONLY
                      </>
                    )}
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  setPaymentOutcome(null);
                  setStep(2);
                }}
                className="s3k-back-btn mt-2"
              >
                <ChevronLeft size={13} className="text-amber-400" />
                <span>Modify Print Settings</span>
              </button>
            </div>
          </div>
        );

      case 4: {
        const isCompleted = jobStatus === 'COMPLETED';
        const isPrinting = jobStatus === 'PRINTING';
        const isFailed = jobStatus === 'FAILED' || jobStatus === 'CANCELLED';
        const isCashMode = paymentMode === 'CASH_AT_COUNTER';

        return (
          <div className="flex flex-col justify-center animate-scale-in" style={{ gap: '0.65rem' }}>
            <div className="s3k-card s3k-card-gold text-center py-5 px-4 flex flex-col items-center justify-center">
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: '50%',
                  background: isCompleted
                    ? 'rgba(16, 185, 129, 0.18)'
                    : isPrinting
                      ? 'rgba(37, 99, 235, 0.25)'
                      : isFailed
                        ? 'rgba(239, 68, 68, 0.2)'
                        : 'rgba(245, 158, 11, 0.2)',
                  border: isCompleted
                    ? '2px solid #10B981'
                    : isPrinting
                      ? '2px solid #3B82F6'
                      : isFailed
                        ? '2px solid #EF4444'
                        : '2px solid #F59E0B',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: isCompleted ? '0 0 20px rgba(16, 185, 129, 0.4)' : '0 0 16px rgba(37, 99, 235, 0.3)',
                  marginBottom: '0.85rem',
                }}
              >
                {isCompleted ? (
                  <CheckCircle size={42} style={{ color: '#10B981' }} />
                ) : isPrinting ? (
                  <Loader size={40} className="animate-spin text-blue-400" />
                ) : isFailed ? (
                  <AlertTriangle size={40} className="text-red-400" />
                ) : (
                  <Printer size={40} className="text-amber-400" />
                )}
              </div>

              <h2 className="text-xl font-black text-white mb-1">
                {isCompleted
                  ? 'Printing Complete!'
                  : isPrinting
                    ? 'Printing Your Document...'
                    : isFailed
                      ? 'Printing Halted'
                      : isCashMode
                        ? 'Cash Received — Printing Started'
                        : 'Payment Verified & Queued'}
              </h2>

              <p className="text-xs text-slate-300 mb-3">
                {isCashMode && !isCompleted && !isFailed ? (
                  <span className="text-emerald-300 font-semibold block mb-1">
                    Your payment is confirmed. Your print job is processing.
                  </span>
                ) : null}
                Job ID: <strong className="text-amber-400">{jobId}</strong>
              </p>

              <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold mb-3"
                style={{
                  background: isCompleted
                    ? 'rgba(16, 185, 129, 0.15)'
                    : isPrinting
                      ? 'rgba(37, 99, 235, 0.25)'
                      : isFailed
                        ? 'rgba(239, 68, 68, 0.2)'
                        : 'rgba(245, 158, 11, 0.2)',
                  color: isCompleted ? '#34D399' : isPrinting ? '#60A5FA' : isFailed ? '#F87171' : '#FBBF24',
                  border: '1px solid currentColor',
                }}
              >
                <span className="w-2 h-2 rounded-full animate-ping" style={{ background: 'currentColor' }} />
                Status: {isCashMode
                  ? (isCompleted ? 'Completed' : isPrinting ? 'Printing' : isFailed ? 'Failed' : 'Processing')
                  : jobStatus}
              </div>

              {/* Operator attention notice when payment succeeded but dispatch failed */}
              {dispatchWarning && (
                <div className="w-full bg-amber-500/15 border border-amber-500/50 rounded-xl p-3 text-left mb-3">
                  <div className="flex items-center gap-1.5 text-amber-400 font-bold text-xs uppercase tracking-wider mb-1">
                    <AlertTriangle size={14} />
                    <span>Print Queue Notice — Operator Attention Required</span>
                  </div>
                  <p className="text-[11px] text-amber-200 font-medium leading-relaxed">
                    Your demo payment was verified, but the print queue could not immediately start.
                    <br />
                    <strong>Do not pay again.</strong> Please inform the store operator to release Job ID <strong>{jobId}</strong> from the Admin Dashboard.
                  </p>
                </div>
              )}

              <div className="w-full bg-slate-900/70 border border-slate-700/80 rounded-xl p-3 text-left mb-3">
                <p className="text-xs font-bold text-amber-400 mb-1">Collection Details</p>
                <p className="text-xs text-slate-300">
                  Printer: <strong className="text-white">{printerInfo?.name || 'Main Shop Printer'}</strong>
                </p>
                <p className="text-xs text-slate-300 mt-0.5">
                  Pickup Location: <strong className="text-white">{printerInfo?.location || 'Counter Output Tray'}</strong>
                </p>
              </div>

              {/* Customer Receipt / Tax Invoice Card */}
              <div className="w-full bg-slate-900/80 border border-amber-400/30 rounded-xl p-3 text-left mb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                    <Receipt size={14} /> Payment Receipt
                  </span>
                  <span className="text-[10px] font-bold text-emerald-400">SPURTI COMMUNICATIONS</span>
                </div>

                {invoiceData ? (
                  <div className="text-[11px] text-slate-300 space-y-0.5 mb-2.5">
                    <div className="flex justify-between">
                      <span>Invoice No.</span>
                      <strong className="text-white">{invoiceData.invoiceNumber}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Amount Paid</span>
                      <strong className="text-white">
                        ₹{Number(invoiceData.totalAmount ?? displayedTotal).toFixed(2)}
                      </strong>
                    </div>
                    {Number(invoiceData.totalTax || 0) > 0 && (
                      <div className="flex justify-between">
                        <span>CGST / SGST</span>
                        <span>
                          ₹{Number(invoiceData.cgstAmount || 0).toFixed(2)} / ₹{Number(invoiceData.sgstAmount || 0).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 mb-2">
                    {invoiceLoading ? 'Preparing receipt...' : `Paid ₹${Number(displayedTotal).toFixed(2)} (Job ${jobId})`}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleDownloadCustomerReceipt}
                  disabled={downloadingReceipt}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {downloadingReceipt ? (
                    <>
                      <Loader size={13} className="animate-spin" /> Downloading PDF Receipt...
                    </>
                  ) : (
                    <>
                      <Download size={13} className="text-amber-400" /> Download PDF Receipt
                    </>
                  )}
                </button>
              </div>

              <p className="text-xs text-slate-300 leading-snug">
                {isCompleted
                  ? 'Please collect your printed pages from the output tray.'
                  : 'Your document is transmitting securely to the printer.'}
              </p>
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="s3k-portal-wrapper">
      {!isConnected && (
        <div
          className="animate-slide-up"
          style={{
            position: 'fixed',
            top: '0.5rem',
            left: '0.75rem',
            right: '0.75rem',
            background: 'rgba(245, 158, 11, 0.95)',
            color: '#070E1E',
            padding: '0.5rem 0.75rem',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            zIndex: 100,
            fontSize: '0.75rem',
            fontWeight: 700,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <WifiOff size={16} />
          <span>Connection interrupted. Reconnecting...</span>
        </div>
      )}

      {error && (
        <div
          className="animate-fade-in"
          style={{
            background: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#FCA5A5',
            padding: '0.45rem 0.75rem',
            borderRadius: 10,
            fontSize: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            marginBottom: '0.35rem',
          }}
        >
          <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
          <span>{typeof error === 'string' ? error : String(error || '')}</span>
        </div>
      )}

      {renderS3KHeader()}
      <StepIndicator step={step} />

      <div className="flex-1 flex flex-col justify-center overflow-hidden" style={{ minHeight: 0 }}>
        {renderStep()}
      </div>

      <footer className="s3k-footer">
        <span>SPURTI COMMUNICATIONS</span>
        <span>•</span>
        <span className="s3k-footer-gold">Powered by S3K</span>
      </footer>

      <DocumentPreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        fileUrl={effectivePreviewUrl}
        fileName={previewFileName || fileData?.originalName}
        fileSize={fileData?.size}
        initialPages={fileData?.pages || 1}
        sessionToken={sessionToken}
      />
    </div>
  );
};

export default MobileView;
