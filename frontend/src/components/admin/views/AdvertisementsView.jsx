import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Megaphone,
  Plus,
  Trash2,
  Eye,
  ArrowUp,
  ArrowDown,
  Check,
  X,
  Calendar,
  Clock,
  Film,
  Image as ImageIcon,
  UploadCloud,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Pencil,
  Monitor,
  Smartphone,
  Layers,
  MapPin,
  Link
} from 'lucide-react';
import { getApiUrl } from '../../../utils/apiConfig';

const API_URL = getApiUrl();

export const AdvertisementsView = ({ isSuperadmin }) => {
  const [advertisements, setAdvertisements] = useState([]);
  const [machines, setMachines] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAdId, setEditingAdId] = useState(null);
  const [previewAd, setPreviewAd] = useState(null);
  const [statusMsg, setStatusMsg] = useState({ text: '', type: '' });

  // Filters State
  const [filterScope, setFilterScope] = useState('ALL');
  const [filterPlacement, setFilterPlacement] = useState('ALL');

  // Form State for creating/editing ad
  const [formData, setFormData] = useState({
    title: '',
    displayDuration: 5,
    displayOrder: 0,
    isActive: true,
    startDate: '',
    endDate: '',
    mediaInputMode: 'UPLOAD', // 'UPLOAD' | 'URL'
    mediaUrl: '',
    mediaFile: null,
    mediaPreviewUrl: '',
    mediaType: 'IMAGE',
    scope: isSuperadmin ? 'GLOBAL' : 'MACHINE_SPECIFIC',
    placement: 'ALL',
    machineId: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch advertisements
  const fetchAdvertisements = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get(`${API_URL}/api/advertisements/admin/all`);
      if (res.data?.success) {
        setAdvertisements(res.data.advertisements || []);
      }
    } catch (err) {
      console.error('Failed to load advertisements:', err);
      showMessage('Failed to load advertisements from server', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch available machines for selector
  const fetchMachines = async () => {
    try {
      const endpoint = isSuperadmin ? `${API_URL}/api/machines` : `${API_URL}/api/machines/my-machines`;
      const res = await axios.get(endpoint);
      if (res.data?.success) {
        setMachines(res.data.machines || []);
      }
    } catch (err) {
      console.warn('Could not load machines for advertisement selector:', err);
    }
  };

  useEffect(() => {
    fetchAdvertisements();
    fetchMachines();
  }, [isSuperadmin]);

  const showMessage = (text, type = 'success') => {
    setStatusMsg({ text, type });
    setTimeout(() => setStatusMsg({ text: '', type: '' }), 4000);
  };

  // Handle local file selection with instant preview
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const localUrl = URL.createObjectURL(file);

    setFormData(prev => ({
      ...prev,
      mediaFile: file,
      mediaPreviewUrl: localUrl,
      mediaType: isVideo ? 'VIDEO' : 'IMAGE',
      title: prev.title || file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ')
    }));
  };

  // Helper to open edit modal
  const handleOpenEdit = (ad) => {
    const isExternal = Boolean(ad.mediaUrl && ad.mediaUrl.startsWith('http'));
    setEditingAdId(ad.id);
    setFormData({
      title: ad.title || '',
      displayDuration: ad.displayDuration || 5,
      displayOrder: ad.displayOrder !== undefined ? ad.displayOrder : 0,
      isActive: Boolean(ad.isActive),
      startDate: ad.startDate ? ad.startDate.slice(0, 10) : '',
      endDate: ad.endDate ? ad.endDate.slice(0, 10) : '',
      mediaInputMode: isExternal ? 'URL' : 'UPLOAD',
      mediaUrl: isExternal ? ad.mediaUrl : '',
      mediaFile: null,
      mediaPreviewUrl: ad.mediaUrl ? (isExternal ? ad.mediaUrl : `${API_URL}${ad.mediaUrl}`) : '',
      mediaType: ad.type || 'IMAGE',
      scope: ad.scope || (isSuperadmin ? 'GLOBAL' : 'MACHINE_SPECIFIC'),
      placement: ad.placement || 'ALL',
      machineId: ad.machineId || ''
    });
    setIsModalOpen(true);
  };

  // Submit advertisement (Create or Update)
  const handleSaveAd = async (e) => {
    e.preventDefault();
    if (!formData.title.trim()) {
      showMessage('Please enter an advertisement title', 'error');
      return;
    }

    if (formData.mediaInputMode === 'URL') {
      if (!formData.mediaUrl.trim()) {
        showMessage('Please enter an external HTTPS media URL', 'error');
        return;
      }
      if (!formData.mediaUrl.trim().startsWith('https://')) {
        showMessage('External media URL must use https:// protocol', 'error');
        return;
      }
    } else {
      if (!editingAdId && !formData.mediaFile) {
        showMessage('Please select an image or video file', 'error');
        return;
      }
    }

    if (formData.scope === 'MACHINE_SPECIFIC' && !formData.machineId) {
      showMessage('Please select an authoritative machine for machine-specific ad', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const data = new FormData();
      data.append('title', formData.title.trim());
      data.append('displayDuration', formData.displayDuration);
      data.append('displayOrder', formData.displayOrder);
      data.append('isActive', formData.isActive);
      if (formData.startDate) data.append('startDate', formData.startDate);
      if (formData.endDate) data.append('endDate', formData.endDate);
      data.append('scope', formData.scope);
      data.append('placement', formData.placement);
      if (formData.scope === 'MACHINE_SPECIFIC') {
        data.append('machineId', formData.machineId);
      }
      if (formData.mediaInputMode === 'URL') {
        data.append('mediaUrl', formData.mediaUrl.trim());
        data.append('type', formData.mediaType);
      } else if (formData.mediaFile) {
        data.append('media', formData.mediaFile);
      }

      let res;
      if (editingAdId) {
        res = await axios.put(`${API_URL}/api/advertisements/admin/${editingAdId}`, data, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
      } else {
        res = await axios.post(`${API_URL}/api/advertisements/admin`, data, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
      }

      if (res.data?.success) {
        showMessage(editingAdId ? 'Advertisement updated successfully!' : 'Advertisement published successfully!', 'success');
        setIsModalOpen(false);
        resetForm();
        fetchAdvertisements();
      }
    } catch (err) {
      console.error('Failed to save advertisement:', err);
      const errMsg = err.response?.data?.error || err.message || 'Failed to save advertisement';
      showMessage(errMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    if (formData.mediaPreviewUrl && formData.mediaFile) {
      URL.revokeObjectURL(formData.mediaPreviewUrl);
    }
    setEditingAdId(null);
    setFormData({
      title: '',
      displayDuration: 5,
      displayOrder: advertisements.length,
      isActive: true,
      startDate: '',
      endDate: '',
      mediaInputMode: 'UPLOAD',
      mediaUrl: '',
      mediaFile: null,
      mediaPreviewUrl: '',
      mediaType: 'IMAGE',
      scope: isSuperadmin ? 'GLOBAL' : 'MACHINE_SPECIFIC',
      placement: 'ALL',
      machineId: machines[0]?.id || ''
    });
  };

  // Toggle active status
  const handleToggleActive = async (id) => {
    try {
      const res = await axios.patch(`${API_URL}/api/advertisements/admin/${id}/toggle`);
      if (res.data?.success) {
        setAdvertisements(prev => prev.map(ad => ad.id === id ? { ...ad, isActive: !ad.isActive } : ad));
        showMessage('Status updated successfully');
      }
    } catch (err) {
      console.error('Toggle failed:', err);
      showMessage('Failed to update advertisement status', 'error');
    }
  };

  // Reorder ads (move up or down)
  const handleReorder = async (index, direction) => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= advertisements.length) return;

    const reordered = [...advertisements];
    const temp = reordered[index];
    reordered[index] = reordered[targetIndex];
    reordered[targetIndex] = temp;

    // Update displayOrder attributes
    const items = reordered.map((ad, idx) => ({ id: ad.id, displayOrder: idx }));

    setAdvertisements(reordered);
    try {
      await axios.patch(`${API_URL}/api/advertisements/admin/reorder`, { items });
      showMessage('Order updated successfully');
    } catch (err) {
      console.error('Reorder failed:', err);
      showMessage('Failed to save updated order', 'error');
      fetchAdvertisements();
    }
  };

  // Delete advertisement
  const handleDelete = async (id, title) => {
    if (!window.confirm(`Are you sure you want to delete advertisement "${title}"?`)) return;

    try {
      const res = await axios.delete(`${API_URL}/api/advertisements/admin/${id}`);
      if (res.data?.success) {
        setAdvertisements(prev => prev.filter(ad => ad.id !== id));
        showMessage('Advertisement deleted');
      }
    } catch (err) {
      console.error('Delete failed:', err);
      showMessage('Failed to delete advertisement', 'error');
    }
  };

  // Helper to format full media URL
  const getFullMediaUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // Metrics
  const totalCount = advertisements.length;
  const activeCount = advertisements.filter(a => a.isActive).length;
  const imageCount = advertisements.filter(a => a.type === 'IMAGE').length;
  const videoCount = advertisements.filter(a => a.type === 'VIDEO').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Status banner */}
      {statusMsg.text && (
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          background: statusMsg.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
          border: `1px solid ${statusMsg.type === 'error' ? '#ef4444' : '#10b981'}`,
          color: statusMsg.type === 'error' ? '#fca5a5' : '#6ee7b7',
          fontSize: '0.875rem',
          fontWeight: 600
        }}>
          {statusMsg.text}
        </div>
      )}

      {/* KPI Cards Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#94A3B8', fontSize: '0.8125rem', fontWeight: 600 }}>Total Advertisements</span>
            <Megaphone size={18} color="#818CF8" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#FFFFFF', marginTop: '0.5rem' }}>{totalCount}</div>
        </div>

        <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#94A3B8', fontSize: '0.8125rem', fontWeight: 600 }}>Active in Kiosk</span>
            <Check size={18} color="#34D399" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#34D399', marginTop: '0.5rem' }}>{activeCount}</div>
        </div>

        <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#94A3B8', fontSize: '0.8125rem', fontWeight: 600 }}>Photos / Banners</span>
            <ImageIcon size={18} color="#FBBF24" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#FBBF24', marginTop: '0.5rem' }}>{imageCount}</div>
        </div>

        <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#94A3B8', fontSize: '0.8125rem', fontWeight: 600 }}>Promo Videos (MP4)</span>
            <Film size={18} color="#60A5FA" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#60A5FA', marginTop: '0.5rem' }}>{videoCount}</div>
        </div>
      </div>

      {/* Main Table / Action Card */}
      <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Card Header & Controls */}
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #1E293B', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>Customer Portal Slideshow Ads</h2>
            <p style={{ fontSize: '0.75rem', color: '#94A3B8', margin: '0.2rem 0 0' }}>Manage photos, video banners, scopes, and placements shown on kiosks and customer mobile screens.</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.625rem' }}>
            {/* Scope Filter */}
            <select
              value={filterScope}
              onChange={(e) => setFilterScope(e.target.value)}
              style={{
                background: '#1E293B', border: '1px solid #334155', borderRadius: '8px',
                padding: '0.5rem 0.65rem', color: '#CBD5E1', fontSize: '0.75rem', fontWeight: 600, outline: 'none'
              }}
            >
              <option value="ALL">All Scopes</option>
              <option value="GLOBAL">Global Only</option>
              <option value="MACHINE_SPECIFIC">Machine-Specific Only</option>
            </select>

            {/* Placement Filter */}
            <select
              value={filterPlacement}
              onChange={(e) => setFilterPlacement(e.target.value)}
              style={{
                background: '#1E293B', border: '1px solid #334155', borderRadius: '8px',
                padding: '0.5rem 0.65rem', color: '#CBD5E1', fontSize: '0.75rem', fontWeight: 600, outline: 'none'
              }}
            >
              <option value="ALL">All Placements</option>
              <option value="KIOSK_ONLY">Kiosk Only</option>
              <option value="MOBILE_ONLY">Mobile Only</option>
            </select>

            <button
              onClick={() => { fetchAdvertisements(); fetchMachines(); }}
              disabled={isLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                background: '#1E293B', border: '1px solid #334155', borderRadius: '8px',
                padding: '0.5rem 0.75rem', color: '#CBD5E1', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer'
              }}
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Refresh
            </button>

            <button
              onClick={() => { resetForm(); setIsModalOpen(true); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
                border: 'none', borderRadius: '8px',
                padding: '0.5rem 0.9rem', color: '#000000', fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(245, 158, 11, 0.3)'
              }}
            >
              <Plus size={16} /> Add Advertisement
            </button>
          </div>
        </div>

        {/* Advertisement List */}
        {advertisements.length === 0 ? (
          <div style={{ padding: '3.5rem 1rem', textAlign: 'center' }}>
            <Megaphone size={42} style={{ color: '#475569', margin: '0 auto 1rem' }} />
            <h3 style={{ color: '#FFFFFF', fontSize: '1rem', fontWeight: 700, margin: '0 0 0.5rem' }}>No Advertisements Configured</h3>
            <p style={{ color: '#94A3B8', fontSize: '0.8125rem', maxWidth: '360px', margin: '0 auto 1.25rem' }}>
              Upload promotional posters, shop offers, or video advertisements to display in the customer mobile portal and kiosk screens.
            </p>
            <button
              onClick={() => { resetForm(); setIsModalOpen(true); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
                border: 'none', borderRadius: '8px',
                padding: '0.5rem 1rem', color: '#FFFFFF', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer'
              }}
            >
              <Plus size={16} /> Create First Advertisement
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8125rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1E293B', background: '#090D1A', color: '#94A3B8' }}>
                  <th style={{ padding: '0.75rem 1rem', width: '50px' }}>Order</th>
                  <th style={{ padding: '0.75rem 1rem', width: '90px' }}>Media</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Title & Format</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Scope & Machine</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Placement</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Display Duration</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Campaign Schedule</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {advertisements
                  .filter(ad => {
                    if (filterScope !== 'ALL' && (ad.scope || 'GLOBAL') !== filterScope) return false;
                    if (filterPlacement !== 'ALL' && (ad.placement || 'ALL') !== filterPlacement) return false;
                    return true;
                  })
                  .map((ad, idx) => {
                    const mediaUrl = getFullMediaUrl(ad.mediaUrl);
                    const isNowActive = ad.isActive &&
                      (!ad.startDate || new Date(ad.startDate) <= new Date()) &&
                      (!ad.endDate || new Date(ad.endDate) >= new Date());

                    return (
                      <tr key={ad.id} style={{ borderBottom: '1px solid #1E293B', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                        {/* Order and Move Buttons */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                            <button
                              onClick={() => handleReorder(idx, 'up')}
                              disabled={idx === 0}
                              style={{
                                background: 'transparent', border: 'none',
                                color: idx === 0 ? '#334155' : '#94A3B8',
                                cursor: idx === 0 ? 'default' : 'pointer', padding: 0
                              }}
                              title="Move Up"
                            >
                              <ArrowUp size={14} />
                            </button>
                            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#F59E0B' }}>#{idx + 1}</span>
                            <button
                              onClick={() => handleReorder(idx, 'down')}
                              disabled={idx === advertisements.length - 1}
                              style={{
                                background: 'transparent', border: 'none',
                                color: idx === advertisements.length - 1 ? '#334155' : '#94A3B8',
                                cursor: idx === advertisements.length - 1 ? 'default' : 'pointer', padding: 0
                              }}
                              title="Move Down"
                            >
                              <ArrowDown size={14} />
                            </button>
                          </div>
                        </td>

                        {/* Thumbnail Preview */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div
                            onClick={() => setPreviewAd(ad)}
                            style={{
                              width: '74px', height: '46px', borderRadius: '6px', overflow: 'hidden',
                              background: '#070E1E', border: '1px solid #334155', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative'
                            }}
                            title="Click to preview"
                          >
                            {ad.type === 'VIDEO' ? (
                              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#020617' }}>
                                <Film size={18} color="#60A5FA" />
                                <span style={{ position: 'absolute', bottom: 2, right: 2, fontSize: '8px', background: 'rgba(0,0,0,0.7)', color: '#60A5FA', padding: '1px 3px', borderRadius: '2px', fontWeight: 700 }}>MP4</span>
                              </div>
                            ) : (
                              <img
                                src={mediaUrl}
                                alt={ad.title}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                            )}
                          </div>
                        </td>

                        {/* Title & Format */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ fontWeight: 700, color: '#FFFFFF', fontSize: '0.875rem' }}>{ad.title}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
                            <span style={{
                              padding: '2px 6px', borderRadius: '4px', fontSize: '0.6875rem', fontWeight: 700,
                              background: ad.type === 'VIDEO' ? 'rgba(37, 99, 235, 0.2)' : 'rgba(245, 158, 11, 0.15)',
                              color: ad.type === 'VIDEO' ? '#93C5FD' : '#FCD34D',
                              border: `1px solid ${ad.type === 'VIDEO' ? 'rgba(37, 99, 235, 0.4)' : 'rgba(245, 158, 11, 0.3)'}`
                            }}>
                              {ad.type === 'VIDEO' ? '🎥 Video Banner' : '🖼️ Promotional Photo'}
                            </span>
                            {ad.fileSize && (
                              <span style={{ color: '#64748B', fontSize: '0.6875rem' }}>
                                {(ad.fileSize / (1024 * 1024)).toFixed(1)} MB
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Scope & Machine */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          {ad.scope === 'MACHINE_SPECIFIC' ? (
                            <div style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)',
                              color: '#34D399', padding: '2px 7px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700
                            }}>
                              <MapPin size={11} />
                              <span>{ad.machine?.name || 'Machine-Specific'}</span>
                            </div>
                          ) : (
                            <div style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              background: 'rgba(99, 102, 241, 0.15)', border: '1px solid rgba(99, 102, 241, 0.3)',
                              color: '#A5B4FC', padding: '2px 7px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700
                            }}>
                              <Layers size={11} />
                              <span>Fleet Global</span>
                            </div>
                          )}
                        </td>

                        {/* Placement */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          {ad.placement === 'KIOSK_ONLY' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: '#FCD34D', fontSize: '0.72rem', fontWeight: 600 }}>
                              <Monitor size={12} /> Kiosk Only
                            </span>
                          ) : ad.placement === 'MOBILE_ONLY' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: '#67E8F9', fontSize: '0.72rem', fontWeight: 600 }}>
                              <Smartphone size={12} /> Mobile Only
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: '#CBD5E1', fontSize: '0.72rem', fontWeight: 600 }}>
                              <Layers size={12} /> All Screens
                            </span>
                          )}
                        </td>

                        {/* Duration */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#CBD5E1' }}>
                            <Clock size={14} color="#94A3B8" />
                            <span>{ad.type === 'VIDEO' ? 'Full Video Length' : `${ad.displayDuration || 5}s Slideshow`}</span>
                          </div>
                        </td>

                        {/* Campaign Schedule */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#94A3B8', fontSize: '0.75rem' }}>
                            <Calendar size={13} />
                            {ad.startDate || ad.endDate ? (
                              <span>
                                {ad.startDate ? new Date(ad.startDate).toLocaleDateString() : 'Now'} - {ad.endDate ? new Date(ad.endDate).toLocaleDateString() : 'Forever'}
                              </span>
                            ) : (
                              <span style={{ color: '#38BDF8' }}>Always Active</span>
                            )}
                          </div>
                        </td>

                        {/* Status */}
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <button
                            onClick={() => handleToggleActive(ad.id)}
                            style={{
                              padding: '3px 8px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
                              background: isNowActive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                              border: `1px solid ${isNowActive ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                              color: isNowActive ? '#34D399' : '#F87171',
                              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem'
                            }}
                            title="Click to toggle status"
                          >
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isNowActive ? '#10B981' : '#EF4444' }} />
                            {isNowActive ? 'ACTIVE' : 'DISABLED'}
                          </button>
                        </td>

                        {/* Actions */}
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem' }}>
                            <button
                              onClick={() => handleOpenEdit(ad)}
                              style={{
                                background: '#1E293B', border: '1px solid #334155', borderRadius: '6px',
                                padding: '5px 8px', color: '#FCD34D', cursor: 'pointer', display: 'flex', alignItems: 'center'
                              }}
                              title="Edit Advertisement"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setPreviewAd(ad)}
                              style={{
                                background: '#1E293B', border: '1px solid #334155', borderRadius: '6px',
                                padding: '5px 8px', color: '#60A5FA', cursor: 'pointer', display: 'flex', alignItems: 'center'
                              }}
                              title="Preview Advertisement"
                            >
                              <Eye size={14} />
                            </button>
                            <button
                              onClick={() => handleDelete(ad.id, ad.title)}
                              style={{
                                background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px',
                                padding: '5px 8px', color: '#EF4444', cursor: 'pointer', display: 'flex', alignItems: 'center'
                              }}
                              title="Delete Advertisement"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CREATE / EDIT ADVERTISEMENT MODAL */}
      {isModalOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
        }}>
          <div style={{
            background: '#0B132B', border: '1px solid #2A3B5C', borderRadius: '14px',
            width: '100%', maxWidth: '540px', maxHeight: '90vh', overflowY: 'auto',
            padding: '1.5rem', boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid #1E293B', paddingBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Megaphone size={20} color="#F59E0B" />
                <h3 style={{ color: '#FFFFFF', fontSize: '1.1rem', fontWeight: 800, margin: 0 }}>
                  {editingAdId ? 'Edit Advertisement' : 'Add New Advertisement'}
                </h3>
              </div>
              <button
                onClick={() => { setIsModalOpen(false); resetForm(); }}
                style={{ background: 'transparent', border: 'none', color: '#94A3B8', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSaveAd} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Scope Selection */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                  Advertisement Scope *
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <button
                    type="button"
                    disabled={!isSuperadmin}
                    onClick={() => setFormData(p => ({ ...p, scope: 'GLOBAL', machineId: '' }))}
                    style={{
                      padding: '8px',
                      borderRadius: '8px',
                      border: `1.5px solid ${formData.scope === 'GLOBAL' ? '#6366F1' : '#334155'}`,
                      background: formData.scope === 'GLOBAL' ? 'rgba(99, 102, 241, 0.15)' : '#070E1E',
                      color: formData.scope === 'GLOBAL' ? '#A5B4FC' : '#94A3B8',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: isSuperadmin ? 'pointer' : 'not-allowed',
                      opacity: isSuperadmin ? 1 : 0.5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px'
                    }}
                  >
                    <Layers size={14} /> Fleet Global
                  </button>

                  <button
                    type="button"
                    onClick={() => setFormData(p => ({ ...p, scope: 'MACHINE_SPECIFIC', machineId: p.machineId || machines[0]?.id || '' }))}
                    style={{
                      padding: '8px',
                      borderRadius: '8px',
                      border: `1.5px solid ${formData.scope === 'MACHINE_SPECIFIC' ? '#10B981' : '#334155'}`,
                      background: formData.scope === 'MACHINE_SPECIFIC' ? 'rgba(16, 185, 129, 0.15)' : '#070E1E',
                      color: formData.scope === 'MACHINE_SPECIFIC' ? '#6EE7B7' : '#94A3B8',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px'
                    }}
                  >
                    <MapPin size={14} /> Machine-Specific
                  </button>
                </div>
                {!isSuperadmin && (
                  <span style={{ fontSize: '0.65rem', color: '#6EE7B7', marginTop: '4px', display: 'block' }}>
                    Franchisees manage advertisements targeted to their assigned kiosks.
                  </span>
                )}
              </div>

              {/* Machine Selector (When MACHINE_SPECIFIC) */}
              {formData.scope === 'MACHINE_SPECIFIC' && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                    Target Machine / Kiosk *
                  </label>
                  <select
                    value={formData.machineId}
                    onChange={(e) => setFormData(p => ({ ...p, machineId: e.target.value }))}
                    required
                    style={{
                      width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                      background: '#070E1E', border: '1px solid #10B981', color: '#FFFFFF',
                      fontSize: '0.8125rem', outline: 'none'
                    }}
                  >
                    <option value="">-- Select Target Machine --</option>
                    {machines.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.location ? `(${m.location})` : ''}
                      </option>
                    ))}
                  </select>
                  {machines.length === 0 && (
                    <span style={{ fontSize: '0.65rem', color: '#EF4444', marginTop: '4px', display: 'block' }}>
                      No available machines found for your account.
                    </span>
                  )}
                </div>
              )}

              {/* Placement Selector */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                  Screen Placement *
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                  {[
                    { id: 'ALL', label: 'All Screens', icon: Layers },
                    { id: 'KIOSK_ONLY', label: 'Kiosk Only', icon: Monitor },
                    { id: 'MOBILE_ONLY', label: 'Mobile Only', icon: Smartphone }
                  ].map(item => {
                    const Icon = item.icon;
                    const isSel = formData.placement === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setFormData(p => ({ ...p, placement: item.id }))}
                        style={{
                          padding: '7px 4px',
                          borderRadius: '8px',
                          border: `1.5px solid ${isSel ? '#F59E0B' : '#334155'}`,
                          background: isSel ? 'rgba(245, 158, 11, 0.15)' : '#070E1E',
                          color: isSel ? '#FCD34D' : '#94A3B8',
                          fontWeight: 700,
                          fontSize: '0.72rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '4px'
                        }}
                      >
                        <Icon size={13} /> {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Media Input Mode & Live Preview */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                  Advertisement Media (Photo or MP4 Video) {editingAdId ? '(Optional if keeping current media)' : '*'}
                </label>

                {/* Source Mode Toggle */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setFormData(p => ({
                        ...p,
                        mediaInputMode: 'UPLOAD',
                        mediaUrl: '',
                        mediaPreviewUrl: p.mediaFile ? URL.createObjectURL(p.mediaFile) : ''
                      }));
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                      background: formData.mediaInputMode === 'UPLOAD' ? 'rgba(245, 158, 11, 0.2)' : '#070E1E',
                      border: `1px solid ${formData.mediaInputMode === 'UPLOAD' ? '#F59E0B' : '#334155'}`,
                      color: formData.mediaInputMode === 'UPLOAD' ? '#FCD34D' : '#94A3B8',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                    }}
                  >
                    <UploadCloud size={13} /> Upload File
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFormData(p => ({
                        ...p,
                        mediaInputMode: 'URL',
                        mediaFile: null,
                        mediaPreviewUrl: p.mediaUrl.startsWith('https://') ? p.mediaUrl : ''
                      }));
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                      background: formData.mediaInputMode === 'URL' ? 'rgba(245, 158, 11, 0.2)' : '#070E1E',
                      border: `1px solid ${formData.mediaInputMode === 'URL' ? '#F59E0B' : '#334155'}`,
                      color: formData.mediaInputMode === 'URL' ? '#FCD34D' : '#94A3B8',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                    }}
                  >
                    <Link size={13} /> External HTTPS URL
                  </button>
                </div>

                {formData.mediaInputMode === 'URL' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <input
                      type="url"
                      placeholder="https://example.com/assets/banner.jpg"
                      value={formData.mediaUrl}
                      onChange={(e) => {
                        const val = e.target.value;
                        const isVid = /\.(mp4|webm|ogg)$/i.test(val);
                        setFormData(p => ({
                          ...p,
                          mediaUrl: val,
                          mediaPreviewUrl: val.startsWith('https://') ? val : '',
                          mediaType: isVid ? 'VIDEO' : p.mediaType
                        }));
                      }}
                      style={{
                        width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                        background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                        fontSize: '0.8125rem', outline: 'none'
                      }}
                    />
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                      <label style={{ fontSize: '0.72rem', color: '#CBD5E1', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="urlMediaType"
                          checked={formData.mediaType === 'IMAGE'}
                          onChange={() => setFormData(p => ({ ...p, mediaType: 'IMAGE' }))}
                        /> Photo / Banner
                      </label>
                      <label style={{ fontSize: '0.72rem', color: '#CBD5E1', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="urlMediaType"
                          checked={formData.mediaType === 'VIDEO'}
                          onChange={() => setFormData(p => ({ ...p, mediaType: 'VIDEO' }))}
                        /> MP4 Video
                      </label>
                    </div>
                  </div>
                ) : null}

                {formData.mediaPreviewUrl ? (
                  <div style={{
                    position: 'relative', borderRadius: '10px', overflow: 'hidden',
                    background: '#070E1E', border: '1px solid #F59E0B', maxHeight: '180px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {formData.mediaType === 'VIDEO' ? (
                      <video
                        src={formData.mediaPreviewUrl}
                        controls
                        muted
                        style={{ width: '100%', maxHeight: '180px', objectFit: 'contain' }}
                      />
                    ) : (
                      <img
                        src={formData.mediaPreviewUrl}
                        alt="Preview"
                        style={{ width: '100%', maxHeight: '180px', objectFit: 'contain' }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setFormData(p => ({ ...p, mediaFile: null, mediaUrl: '', mediaPreviewUrl: '' }))}
                      style={{
                        position: 'absolute', top: '8px', right: '8px',
                        background: 'rgba(239, 68, 68, 0.85)', color: '#FFFFFF',
                        border: 'none', borderRadius: '50%', width: 24, height: 24,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
                      }}
                      title="Remove media"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : formData.mediaInputMode === 'UPLOAD' ? (
                  <label style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    border: '2px dashed #334155', borderRadius: '10px', padding: '1.75rem 1rem',
                    background: 'rgba(15, 23, 42, 0.6)', cursor: 'pointer', textAlign: 'center'
                  }}>
                    <UploadCloud size={32} color="#F59E0B" style={{ marginBottom: '0.5rem' }} />
                    <span style={{ color: '#FFFFFF', fontSize: '0.8125rem', fontWeight: 600 }}>Click to browse Photo or Video</span>
                    <span style={{ color: '#64748B', fontSize: '0.7rem', marginTop: '0.2rem' }}>Supports PNG, JPG, WEBP, MP4, WEBM (Max 50MB)</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
                      onChange={handleFileChange}
                      style={{ display: 'none' }}
                    />
                  </label>
                ) : null}
              </div>

              {/* Title */}
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                  Advertisement Title *
                </label>
                <input
                  type="text"
                  placeholder="e.g. 50% Off Color Prints This Weekend"
                  value={formData.title}
                  onChange={(e) => setFormData(p => ({ ...p, title: e.target.value }))}
                  required
                  style={{
                    width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                    background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                    fontSize: '0.8125rem', outline: 'none'
                  }}
                />
              </div>

              {/* Display Duration & Display Order */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                    Photo Duration (Seconds)
                  </label>
                  <input
                    type="number"
                    min="2"
                    max="60"
                    value={formData.displayDuration}
                    onChange={(e) => setFormData(p => ({ ...p, displayDuration: e.target.value }))}
                    disabled={formData.mediaType === 'VIDEO'}
                    style={{
                      width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                      background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                      fontSize: '0.8125rem', outline: 'none'
                    }}
                  />
                  <span style={{ fontSize: '0.65rem', color: '#64748B', marginTop: '0.2rem', display: 'block' }}>
                    {formData.mediaType === 'VIDEO' ? 'Videos play to completion' : 'Time before next slide'}
                  </span>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                    Display Order Priority
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.displayOrder}
                    onChange={(e) => setFormData(p => ({ ...p, displayOrder: e.target.value }))}
                    style={{
                      width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                      background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                      fontSize: '0.8125rem', outline: 'none'
                    }}
                  />
                  <span style={{ fontSize: '0.65rem', color: '#64748B', marginTop: '0.2rem', display: 'block' }}>
                    Lower number shows first
                  </span>
                </div>
              </div>

              {/* Campaign Schedule Dates (Optional) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                    Start Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData(p => ({ ...p, startDate: e.target.value }))}
                    style={{
                      width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                      background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                      fontSize: '0.75rem', outline: 'none'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
                    End Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => setFormData(p => ({ ...p, endDate: e.target.value }))}
                    style={{
                      width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                      background: '#070E1E', border: '1px solid #334155', color: '#FFFFFF',
                      fontSize: '0.75rem', outline: 'none'
                    }}
                  />
                </div>
              </div>

              {/* Active Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                <input
                  type="checkbox"
                  id="isActiveCheck"
                  checked={formData.isActive}
                  onChange={(e) => setFormData(p => ({ ...p, isActive: e.target.checked }))}
                  style={{ width: 16, height: 16, accentColor: '#F59E0B' }}
                />
                <label htmlFor="isActiveCheck" style={{ fontSize: '0.8125rem', color: '#FFFFFF', fontWeight: 600, cursor: 'pointer' }}>
                  Enable immediately in customer kiosk
                </label>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); resetForm(); }}
                  disabled={isSubmitting}
                  style={{
                    padding: '0.55rem 1rem', borderRadius: '8px',
                    background: '#1E293B', border: '1px solid #334155', color: '#CBD5E1',
                    fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: '0.55rem 1.25rem', borderRadius: '8px',
                    background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
                    border: 'none', color: '#000000', fontSize: '0.8125rem', fontWeight: 800,
                    cursor: 'pointer', boxShadow: '0 2px 10px rgba(245, 158, 11, 0.3)',
                    display: 'flex', alignItems: 'center', gap: '0.4rem'
                  }}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" /> Saving...
                    </>
                  ) : (
                    <>
                      <Check size={16} /> {editingAdId ? 'Update Advertisement' : 'Publish Advertisement'}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FULL CUSTOMER PREVIEW MODAL */}
      {previewAd && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
        }}>
          <div style={{
            background: '#070E1E', border: '1.5px solid rgba(245, 158, 11, 0.5)', borderRadius: '16px',
            width: '100%', maxWidth: '420px', overflow: 'hidden',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)'
          }}>
            <div style={{
              padding: '0.75rem 1rem', background: '#090D1A', borderBottom: '1px solid #1E293B',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <div>
                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#F59E0B', fontWeight: 800 }}>
                  Customer Kiosk Viewport Preview
                </span>
                <h4 style={{ color: '#FFFFFF', margin: 0, fontSize: '0.875rem', fontWeight: 700 }}>{previewAd.title}</h4>
              </div>
              <button
                onClick={() => setPreviewAd(null)}
                style={{
                  background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.4)',
                  color: '#F87171', borderRadius: '6px', padding: '4px 6px', cursor: 'pointer'
                }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: '1rem', background: '#050B18' }}>
              <div style={{
                position: 'relative', width: '100%', borderRadius: '12px', overflow: 'hidden',
                background: '#020617', border: '1px solid rgba(148, 163, 184, 0.2)',
                aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                {previewAd.type === 'VIDEO' ? (
                  <video
                    src={getFullMediaUrl(previewAd.mediaUrl)}
                    autoPlay
                    loop
                    muted
                    playsInline
                    controls
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <img
                    src={getFullMediaUrl(previewAd.mediaUrl)}
                    alt={previewAd.title}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                )}
                <div style={{
                  position: 'absolute', bottom: '8px', left: '8px',
                  background: 'rgba(7, 14, 30, 0.85)', backdropFilter: 'blur(4px)',
                  padding: '3px 8px', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.4)',
                  color: '#FFFFFF', fontSize: '0.7rem', fontWeight: 700
                }}>
                  {previewAd.title}
                </div>
              </div>

              <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: '#94A3B8' }}>
                <span>Format: <strong style={{ color: '#FFFFFF' }}>{previewAd.type}</strong></span>
                <span>Duration: <strong style={{ color: '#F59E0B' }}>{previewAd.type === 'VIDEO' ? 'Video Duration' : `${previewAd.displayDuration}s`}</strong></span>
                <span>Status: <strong style={{ color: previewAd.isActive ? '#34D399' : '#F87171' }}>{previewAd.isActive ? 'Active' : 'Disabled'}</strong></span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
