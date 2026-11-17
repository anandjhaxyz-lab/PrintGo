import React, { useState, useEffect, useRef } from 'react';
import { Volume2, VolumeX, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { getApiUrl } from '../utils/apiConfig';

const API_URL = getApiUrl();

export const AdvertisementDisplay = ({
  ads: initialAds,
  sessionToken,
  publicCode,
  placement,
  onSuppressed
}) => {
  const [ads, setAds] = useState(initialAds || []);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [failedIds, setFailedIds] = useState(new Set());
  const videoRef = useRef(null);
  const timerRef = useRef(null);

  // Fetch active ads if not provided via props
  useEffect(() => {
    if (initialAds) {
      setAds(initialAds);
      return;
    }

    let isMounted = true;

    const fetchAds = async () => {
      try {
        const params = new URLSearchParams();
        if (placement) params.append('placement', placement);
        if (publicCode) params.append('publicCode', publicCode);

        const queryString = params.toString();
        const url = `${API_URL}/api/advertisements/active${queryString ? `?${queryString}` : ''}`;
        const headers = {};
        if (sessionToken) {
          headers['Authorization'] = `Bearer ${sessionToken}`;
        }

        const res = await fetch(url, { headers });
        const data = await res.json();
        if (!isMounted) return;

        if (data?.success) {
          if (data.suppressed) {
            setAds([]);
            if (onSuppressed) onSuppressed(data.reason);
          } else if (Array.isArray(data.advertisements)) {
            setAds(data.advertisements);
          }
        }
      } catch (e) {
        console.warn('Could not load advertisements:', e);
      }
    };

    fetchAds();

    return () => {
      isMounted = false;
    };
  }, [initialAds, sessionToken, publicCode, placement, onSuppressed]);

  // Clean unmount guard: pause any playing video
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
        } catch (_) {}
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Filter out any broken media
  const validAds = ads.filter(ad => !failedIds.has(ad.id));

  // If current index is out of bounds, reset
  useEffect(() => {
    if (currentIndex >= validAds.length && validAds.length > 0) {
      setCurrentIndex(0);
    }
  }, [validAds.length, currentIndex]);

  // Current active ad
  const currentAd = validAds[currentIndex];

  // Helper to format full media URL
  const getFullMediaUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // Slideshow automatic rotation timer
  useEffect(() => {
    if (validAds.length <= 1 || isPaused || !currentAd) return;

    // For images: rotate after displayDuration seconds
    if (currentAd.type === 'IMAGE') {
      const durationMs = Math.max(2, currentAd.displayDuration || 5) * 1000;
      timerRef.current = setTimeout(() => {
        setCurrentIndex(prev => (prev + 1) % validAds.length);
      }, durationMs);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [currentIndex, validAds.length, isPaused, currentAd]);

  // Video completion handler for multi-ad rotation
  const handleVideoEnded = () => {
    if (validAds.length > 1) {
      setCurrentIndex(prev => (prev + 1) % validAds.length);
    } else if (videoRef.current) {
      // Single video: loop
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  // Mark ad as broken on error so it disappears cleanly
  const handleMediaError = (adId) => {
    setFailedIds(prev => new Set([...prev, adId]));
  };

  // If no advertisements exist, hide cleanly
  if (validAds.length === 0 || !currentAd) {
    return null;
  }

  const mediaUrl = getFullMediaUrl(currentAd.mediaUrl);
  const isVideo = currentAd.type === 'VIDEO';

  return (
    <div 
      className="s3k-ad-card"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={() => setIsPaused(true)}
      onTouchEnd={() => setIsPaused(false)}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 9',
        borderRadius: '12px',
        overflow: 'hidden',
        background: '#040814',
        border: '1.5px solid rgba(212, 175, 55, 0.35)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4), inset 0 0 12px rgba(212, 175, 55, 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {/* Media Display - 16:9 Standard Canvas with object-fit: cover */}
      {isVideo ? (
        <video
          key={mediaUrl}
          ref={videoRef}
          src={mediaUrl}
          autoPlay
          muted={isMuted}
          playsInline
          loop={validAds.length === 1}
          onEnded={handleVideoEnded}
          onError={() => handleMediaError(currentAd.id)}
          className="s3k-ad-media"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            background: '#000000',
            display: 'block'
          }}
        />
      ) : (
        <img
          key={mediaUrl}
          src={mediaUrl}
          alt={currentAd.title}
          onError={() => handleMediaError(currentAd.id)}
          className="s3k-ad-media"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            display: 'block'
          }}
        />
      )}

      {/* Title & Badge Pill */}
      <div style={{
        position: 'absolute',
        top: '6px',
        left: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        background: 'rgba(7, 14, 30, 0.85)',
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(245, 158, 11, 0.4)',
        padding: '2px 7px',
        borderRadius: '9999px',
        zIndex: 5,
        maxWidth: '85%'
      }}>
        <Sparkles size={11} color="#F59E0B" style={{ flexShrink: 0 }} />
        <span style={{
          fontSize: '0.65rem',
          fontWeight: 800,
          color: '#FFFFFF',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          letterSpacing: '-0.01em'
        }}>
          {currentAd.title}
        </span>
      </div>

      {/* Video Audio Control Toggle */}
      {isVideo && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsMuted(prev => !prev);
            if (videoRef.current) {
              videoRef.current.muted = !isMuted;
            }
          }}
          style={{
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            zIndex: 6,
            background: isMuted ? 'rgba(15, 23, 42, 0.85)' : 'rgba(245, 158, 11, 0.9)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            color: isMuted ? '#CBD5E1' : '#000000',
            borderRadius: '50%',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,0.5)'
          }}
          title={isMuted ? 'Tap to unmute sound' : 'Tap to mute sound'}
        >
          {isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}

      {/* Multi-Ad Pagination Dots */}
      {validAds.length > 1 && (
        <div style={{
          position: 'absolute',
          bottom: '6px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          background: 'rgba(7, 14, 30, 0.7)',
          backdropFilter: 'blur(3px)',
          padding: '2px 6px',
          borderRadius: '9999px',
          zIndex: 5
        }}>
          {validAds.map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentIndex(idx);
              }}
              style={{
                width: idx === currentIndex ? 14 : 5,
                height: 5,
                borderRadius: '9999px',
                background: idx === currentIndex ? '#F59E0B' : 'rgba(255, 255, 255, 0.35)',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                transition: 'all 0.25s ease'
              }}
              title={`Slide ${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
