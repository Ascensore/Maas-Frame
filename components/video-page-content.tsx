'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Hls from 'hls.js';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { type AnnotationStroke, type AnnotationCanvasHandle } from '@/components/annotation-canvas';
import { PlayerCore } from '@/components/video-page/player-core';
import { VideoPageHeader } from '@/components/video-page/video-page-header';
import { VideoMetadataFields } from '@/components/video-page/video-metadata-fields';
import { ImagePreviewDialog } from '@/components/video-page/image-preview-dialog';
import { CompareVersionsDialog } from '@/components/video-page/compare-versions-dialog';
import { VideoPageLoading } from '@/components/video-page/video-page-loading';
import { VideoPageError } from '@/components/video-page/video-page-error';
import { GuestNameGate } from '@/components/video-page/guest-name-gate';
import { useCommentMedia } from '@/components/video-page/hooks/use-comment-media';
import { validateAnnotationStrokes } from '@/lib/validation';
import { resolveR2PlaybackUrl } from '@/lib/video-upload-validation';
import { reviewWatermarkLabel } from '@/lib/review-watermark';
import { useVersionActions } from '@/components/video-page/hooks/use-version-actions';
import { useWatchProgress } from '@/components/video-page/hooks/use-watch-progress';
import { useVideoPlayer } from '@/components/video-page/hooks/use-video-player';
import { useCommentActions } from '@/components/video-page/hooks/use-comment-actions';
import { useVideoPageData } from '@/components/video-page/hooks/use-video-page-data';
import { useCommentExport } from '@/components/video-page/hooks/use-comment-export';
import { useDownloadActions } from '@/components/video-page/hooks/use-download-actions';
import { useVersionDurationSync } from '@/components/video-page/hooks/use-version-duration-sync';
import { CommentComposer } from '@/components/video-page/comment-composer';
import { CommentsPane } from '@/components/video-page/comments-pane';
import { ReviewCommandPalette } from '@/components/video-page/review-command-palette';
import { KeyboardShortcutsModal } from '@/components/keyboard-shortcuts-modal';
import { useReviewHotkeys } from '@/components/video-page/hooks/use-review-hotkeys';
import { draftRangeSpan } from '@/lib/comment-range';
import { AssetsPane } from '@/components/video-page/assets-pane';
import { ApprovalRequestDialog } from '@/components/video-page/approval-request-dialog';
import { ApprovalRequestsPanel } from '@/components/video-page/approval-requests-panel';
import { TranscriptPane } from '@/components/video-page/transcript-pane';
import { TranscriptSidebar } from '@/components/video-page/transcript-sidebar';
import type {
  CommentMarker,
  PlayerAdapter,
  VideoPageCommentsActions,
  VideoPageCompareActions,
  VideoPageComposerActions,
  VideoPageHeaderActions,
} from '@/components/video-page/types';
import { useApprovals } from '@/components/video-page/hooks/use-approvals';
import { useVideoAssets } from '@/components/video-page/hooks/use-video-assets';
import { useSubtitles } from '@/components/video-page/hooks/use-subtitles';
import { useYoutubeCaptions } from '@/components/video-page/hooks/use-youtube-captions';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';

function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatBunnyQualityLabel(
  level: { height?: number; bitrate?: number },
  index: number
): string {
  if (typeof level.height === 'number' && level.height > 0) {
    return `${level.height}p`;
  }
  if (typeof level.bitrate === 'number' && level.bitrate > 0) {
    return `${Math.round(level.bitrate / 1000)} kbps`;
  }
  return `Level ${index + 1}`;
}

export type VideoPageMode = 'dashboard' | 'watch';

interface VideoPageContentProps {
  mode: VideoPageMode;
  videoId: string;
  projectId?: string;
  directUploadsEnabled?: boolean;
  directUploadProvider?: import('@/components/video-page/types').DirectUploadProvider;
}

export function VideoPageContent({
  mode,
  videoId,
  projectId: propProjectId,
  directUploadsEnabled = false,
  directUploadProvider = 'bunny',
}: VideoPageContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bunnyViewportRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<YT.Player | PlayerAdapter | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const scrubReadoutRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const scheduleWatchProgressSaveRef = useRef<
    (input: { progress: number; duration?: number; immediate?: boolean; force?: boolean }) => void
  >(() => {});

  const {
    playingVoiceId,
    voiceProgress,
    voiceCurrentTime,
    voicePlaybackRate,
    playVoice,
    toggleVoiceSpeed,
  } = useCommentMedia();
  const [showResolved, setShowResolved] = useState(false);
  const [activeSidePane, setActiveSidePane] = useState<'comments' | 'assets'>('comments');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [highlightedAssetId, setHighlightedAssetId] = useState<string | null>(null);

  const editAnnotationCanvasRef = useRef<AnnotationCanvasHandle>(null);

  // Annotation state
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotationStrokes, setAnnotationStrokes] = useState<AnnotationStroke[] | null>(null);
  const [viewingAnnotation, setViewingAnnotation] = useState<AnnotationStroke[] | null>(null);
  const annotationCanvasRef = useRef<AnnotationCanvasHandle>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rangeDragCommitRef = useRef<(start: number, end: number) => void>(() => {});
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [reviewShortcutsOpen, setReviewShortcutsOpen] = useState(false);

  const [guestName, setGuestName] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('openframe_guest_name') || '';
  });
  const [guestNameConfirmed, setGuestNameConfirmed] = useState(() => {
    if (mode === 'dashboard') return true;
    if (typeof window === 'undefined') return false;
    return !!localStorage.getItem('openframe_guest_name');
  });

  // Compare dialog state
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [selectedCompareVersions, setSelectedCompareVersions] = useState<Set<string>>(new Set());
  const [showApprovalRequestDialog, setShowApprovalRequestDialog] = useState(false);
  const [showApprovalsPanel, setShowApprovalsPanel] = useState(false);
  const router = useRouter();

  const {
    video,
    setVideo,
    loading,
    error,
    activeVersionId,
    setActiveVersionId,
    availableTags,
    selectedTagId,
    setSelectedTagId,
    projectId,
    fetchVersionComments,
  } = useVideoPageData({
    mode,
    videoId,
    propProjectId,
  });

  const isGuest = video ? !video.isAuthenticated : false;
  const canInitializePlayer = mode !== 'watch' || !isGuest || guestNameConfirmed;
  const normalizedGuestName = guestName.trim();
  const reviewWatermark = !video?.reviewWatermark
    ? null
    : isGuest && normalizedGuestName
      ? reviewWatermarkLabel({ guestName: normalizedGuestName })
      : video.reviewWatermark;
  const canUploadAssets = !!video?.canUploadAssets;
  const canDownloadAssets = !!video?.canDownloadAssets;

  const {
    assets,
    isLoadingAssets,
    isCreatingAsset,
    deletingAssetIds,
    activeDownloadAssetId,
    hasMoreAssets,
    isLoadingMoreAssets,
    fetchAssets,
    loadMoreAssets,
    createAsset,
    deleteAsset,
    downloadAsset,
    getGuestUploadToken,
  } = useVideoAssets({
    videoId,
    isAuthenticated: !!video?.isAuthenticated,
    canUploadAssets,
    canDownloadAssets,
    guestName: normalizedGuestName,
  });

  const {
    showVersionDialog,
    setShowVersionDialog,
    newVersionUrl,
    newVersionLabel,
    setNewVersionLabel,
    newVersionSource,
    newVersionUrlError,
    isCreatingVersion,
    newVersionMode,
    setNewVersionMode,
    newVersionFile,
    setNewVersionFile,
    newVersionUploadProgress,
    newVersionUploadStatus,
    handleNewVersionUrlChange,
    handleCreateVersion,
    showDeleteVersionDialog,
    setShowDeleteVersionDialog,
    setVersionToDelete,
    isDeletingVersion,
    handleDeleteVersion,
  } = useVersionActions({
    projectId: propProjectId,
    videoId,
    directUploadsEnabled,
    directUploadProvider,
    setVideo,
    activeVersionId,
    setActiveVersionId,
  });

  // Cursor idle detection: hide overlay when cursor idle for 3s while playing
  // Memoize version selection handler to prevent recreating on each render
  const handleVersionSelect = useCallback(
    (versionId: string) => {
      setActiveVersionId(versionId);
    },
    [setActiveVersionId]
  );

  // Memoize toggle show resolved handler
  const handleToggleShowResolved = useCallback(() => {
    setShowResolved((prev) => !prev);
  }, []);

  const handleAssetMentionClick = useCallback((assetId: string) => {
    setActiveSidePane('assets');
    setHighlightedAssetId(assetId);
  }, []);

  const { isExportingCsv, isExportingPdf, exportComments } = useCommentExport({
    activeVersionId,
    showResolved,
  });

  // Determine current user info for permission checks and comment display
  const currentUserId = video?.currentUserId || null;
  const currentUserName = video?.currentUserName || null;
  const canResolveComments = !!video?.canResolveComments;
  const canRequestApproval = !!video?.canRequestApproval;
  const canShareVideo = !!video?.canShareVideo;
  const agentsEnabled = !!video?.agentsEnabled;
  const canManageAgentComments = !!video?.canManageAgentComments;
  const [agentRunBusy, setAgentRunBusy] = useState(false);
  const [agentRunError, setAgentRunError] = useState<string | null>(null);

  const refreshAgentRuns = useCallback(async (versionId: string) => {
    const res = await fetch(`/api/versions/${versionId}/agent-runs`, { cache: 'no-store' });
    if (!res.ok) return;
    const payload: unknown = await res.json().catch(() => null);
    const runs =
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      payload.data &&
      typeof payload.data === 'object' &&
      'runs' in payload.data &&
      Array.isArray(payload.data.runs)
        ? payload.data.runs
        : null;
    if (!runs) return;
    const latest = runs[0] as { status?: string; error?: string | null } | undefined;
    if (!latest) {
      setAgentRunBusy(false);
      setAgentRunError(null);
      return;
    }
    setAgentRunBusy(latest.status === 'PENDING' || latest.status === 'RUNNING');
    setAgentRunError(latest.status === 'FAILED' ? (latest.error ?? 'AI review failed') : null);
  }, []);

  useEffect(() => {
    if (!agentRunBusy || !activeVersionId) return;
    const timer = setInterval(() => {
      void refreshAgentRuns(activeVersionId);
    }, 2000);
    return () => clearInterval(timer);
  }, [agentRunBusy, activeVersionId, refreshAgentRuns]);

  const handleRunAgentReview = useCallback(async () => {
    if (!activeVersionId) return;
    setAgentRunError(null);
    setAgentRunBusy(true);
    const res = await fetch(`/api/versions/${activeVersionId}/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.status === 409) {
      void refreshAgentRuns(activeVersionId);
      return;
    }
    if (!res.ok) {
      const payload: unknown = await res.json().catch(() => null);
      const message =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
          ? payload.error
          : 'Failed to start AI review';
      setAgentRunBusy(false);
      setAgentRunError(message);
      return;
    }
    void refreshAgentRuns(activeVersionId);
  }, [activeVersionId, refreshAgentRuns]);

  const {
    requests: approvalRequests,
    candidates: approvalCandidates,
    isLoadingRequests: isLoadingApprovals,
    isLoadingCandidates: isLoadingApprovalCandidates,
    isSubmittingRequest: isSubmittingApprovalRequest,
    isSubmittingDecision: isSubmittingApprovalDecision,
    isCancelingRequest: isCancelingApprovalRequest,
    activePendingRequest,
    error: approvalError,
    setError: setApprovalError,
    fetchRequests: fetchApprovalRequests,
    fetchCandidates: fetchApprovalCandidates,
    createRequest: createApprovalRequest,
    submitDecision: submitApprovalDecision,
    cancelRequest: cancelApprovalRequest,
  } = useApprovals({
    projectId,
    activeVersionId,
    currentUserId,
  });

  // Memoize active version lookup to avoid recalculating on every render
  const activeVersion = useMemo(() => {
    return (
      video?.versions?.find((v) => v.id === activeVersionId) ||
      video?.versions?.find((v) => v.isActive) ||
      video?.versions?.[0]
    );
  }, [video?.versions, activeVersionId]);
  const activeProviderId = activeVersion?.providerId;
  // Only the providers that play through our own <video> element can carry a <track>.
  // A YouTube version is an iframe we do not control, and it brings its own captions.
  const supportsSubtitles = activeProviderId === 'bunny' || activeProviderId === 'r2';
  const {
    subtitles,
    subtitleTrackKey,
    canManageSubtitles,
    activeSubtitleLanguage,
    selectSubtitleLanguage,
    uploadSubtitle,
    deleteSubtitle,
    generateSubtitles,
    isUploadingSubtitle,
    isGeneratingSubtitles,
  } = useSubtitles({
    videoId,
    versionId: activeVersionId,
    videoRef,
    supportsSubtitles,
  });
  const canManageCaptions = canShareVideo || canManageSubtitles;
  const canGenerateCaptions = supportsSubtitles && canManageCaptions;
  const activeVersionDuration = activeVersion?.duration;
  const bunnyCdnHostname = useMemo(() => resolvePublicBunnyCdnHostname(), []);
  const embedUrl = useMemo(() => {
    if (!activeVersion) return '';
    if (activeVersion.providerId === 'youtube') {
      const base = `https://www.youtube.com/embed/${activeVersion.videoId}?enablejsapi=1&rel=0&modestbranding=1&controls=0&showinfo=0&iv_load_policy=3&disablekb=1`;
      if (typeof window === 'undefined') return base;
      const origin = window.location.origin;
      return `${base}&origin=${encodeURIComponent(origin)}`;
    }
    if (activeVersion.providerId === 'bunny') {
      if (!bunnyCdnHostname) return '';
      return `https://${bunnyCdnHostname}/${activeVersion.videoId}/playlist.m3u8`;
    }
    if (activeVersion.providerId === 'r2') {
      return resolveR2PlaybackUrl(activeVersion);
    }
    try {
      const url = new URL(activeVersion.originalUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return '';
      }
      return activeVersion.originalUrl;
    } catch {
      return '';
    }
  }, [activeVersion, bunnyCdnHostname]);

  const {
    isReady,
    youtubeModuleRevision,
    bunnyPlaybackState,
    currentTime,
    getCurrentTime,
    setCurrentTime,
    videoDuration,
    isPlaying,
    isMuted,
    isFrameMode,
    frameStepLabel,
    estimatedFrameRate,
    showScrubReadout,
    playbackSpeed,
    playbackSpeedBounds,
    qualityOptions,
    selectedQualityLevel,
    isBunnyPortraitSource,
    bunnyPortraitFrameWidth,
    cursorIdle,
    isFullscreenMode,
    showComments,
    isMobileCommentsOpen,
    setShowComments,
    setIsMobileCommentsOpen,
    handleVideoMouseMove,
    handleVideoMouseLeave,
    handlePlayPause,
    handleSeekToTimestamp,
    handleMuteToggle,
    handleFrameModeToggle,
    handleSkip,
    handleSpeedNudge,
    handleQualityChange,
    handleTimelineMouseDown,
    handleTimelineMouseMove,
    toggleFullscreen,
  } = useVideoPlayer({
    activeVersion,
    activeVersionId,
    activeProviderId,
    embedUrl,
    canInitializePlayer,
    iframeRef,
    videoRef,
    bunnyViewportRef,
    timelineRef,
    progressRef,
    playheadRef,
    scrubReadoutRef,
    hlsRef,
    playerRef,
    formatTime,
    formatBunnyQualityLabel,
    scheduleWatchProgressSaveRef,
    setViewingAnnotation,
    onRangeDragCommitRef: rangeDragCommitRef,
  });

  const { youtubeCaptionTracks, activeYoutubeCaptionLanguage, selectYoutubeCaptionLanguage } =
    useYoutubeCaptions({
      videoId,
      versionId: activeVersionId,
      playerRef,
      enabled: activeProviderId === 'youtube',
      isReady,
      moduleRevision: youtubeModuleRevision,
    });

  // One CC menu, two sources behind it. A YouTube version can only offer the captions the
  // video already carries, so nothing there is ours to manage.
  const isYoutubeVersion = activeProviderId === 'youtube';
  const subtitleTracks = isYoutubeVersion ? youtubeCaptionTracks : subtitles;
  const activeCaptionLanguage = isYoutubeVersion
    ? activeYoutubeCaptionLanguage
    : activeSubtitleLanguage;
  const selectCaptionLanguage = isYoutubeVersion
    ? selectYoutubeCaptionLanguage
    : selectSubtitleLanguage;

  const {
    savedProgress,
    showResumePrompt,
    scheduleWatchProgressSave,
    handleResumeFromSaved,
    handleDismissResume,
  } = useWatchProgress({
    videoId,
    activeVersionId,
    isAuthenticated: !!video?.isAuthenticated,
    pathname,
    playerRef,
    isReady,
    currentTime,
    videoDuration,
  });

  useEffect(() => {
    scheduleWatchProgressSaveRef.current = scheduleWatchProgressSave;
  }, [scheduleWatchProgressSave]);

  const handleResumeFromSavedWithSync = useCallback(() => {
    const resumed = handleResumeFromSaved();
    if (typeof resumed === 'number') {
      setCurrentTime(resumed);
    }
  }, [handleResumeFromSaved, setCurrentTime]);

  const { activeDownloadTarget, isDownloadingVideo, startDownload } = useDownloadActions({
    activeVersion,
    video,
  });

  // Memoize comments array
  const comments = useMemo(() => {
    return activeVersion?.comments || [];
  }, [activeVersion]);

  // Memoize filtered comments to avoid filtering on every render
  const filteredComments = useMemo(() => {
    return comments.filter((c) => showResolved || !c.isResolved);
  }, [comments, showResolved]);

  // Memoize sorted comments to avoid sorting on every render
  const sortedComments = useMemo(() => {
    return [...filteredComments].sort((a, b) => a.timestamp - b.timestamp);
  }, [filteredComments]);

  // Memoize duration computation
  const duration = useMemo(() => {
    return videoDuration || activeVersion?.duration || 0;
  }, [videoDuration, activeVersion?.duration]);

  const selectedQualityLabel = useMemo(() => {
    if (selectedQualityLevel === -2) return 'Original';
    if (selectedQualityLevel === -1) return 'Auto';
    return qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? 'Auto';
  }, [qualityOptions, selectedQualityLevel]);

  useEffect(() => {
    if (!activeVersionId || mode !== 'dashboard') return;
    void fetchApprovalRequests();
  }, [activeVersionId, fetchApprovalRequests, mode]);

  useEffect(() => {
    if (!showApprovalRequestDialog || mode !== 'dashboard') return;
    void fetchApprovalCandidates();
  }, [fetchApprovalCandidates, mode, showApprovalRequestDialog]);

  const {
    commentText,
    setCommentText,
    isSubmittingComment,
    isRecording,
    recordingTime,
    audioBlob,
    isUploadingAudio,
    imageFiles,
    commentRangeStart,
    commentRangeEnd,
    markCommentRangeIn,
    markCommentRangeOut,
    clearCommentRangeSelection,
    applyCommentRange,
    isUploadingImage,
    imageInputRef,
    removeImageFile,
    handleAddComment,
    handleImageSelect,
    handlePaste,
    handleDrop,
    startRecording,
    stopRecording,
    cancelRecording,
    submitCommentWithMedia,
    replyingTo,
    setReplyingTo,
    replyText,
    setReplyText,
    isSubmittingReply,
    isReplyRecording,
    replyRecordingTime,
    replyAudioBlob,
    replyImageFiles,
    replyRangeStart,
    replyRangeEnd,
    markReplyRangeIn,
    markReplyRangeOut,
    clearReplyRangeSelection,
    isUploadingReplyAudio,
    isUploadingReplyImage,
    replyImageInputRef,
    handleReplyComment,
    startReplyRecording,
    stopReplyRecording,
    cancelReplyRecording,
    submitReplyWithMedia,
    editingCommentId,
    editText,
    setEditText,
    editTagId,
    setEditTagId,
    editAnnotationData,
    setEditAnnotationData,
    isEditingAnnotation,
    setIsEditingAnnotation,
    editImageUrls,
    editImageFiles,
    editImageInputRef,
    startEditingComment,
    startEditingReply,
    cancelEditingComment,
    removeEditImageUrl,
    isSubmittingEdit,
    handleEditComment,
    handleDeleteComment,
    handleResolveComment,
    previewImage,
    setPreviewImage,
  } = useCommentActions({
    videoId,
    setVideo,
    activeVersionId,
    activeVersion,
    currentTime,
    isGuest,
    normalizedGuestName,
    currentUserName,
    canResolveComments,
    availableTags,
    selectedTagId,
    setSelectedTagId,
    annotationStrokes,
    setAnnotationStrokes,
    isAnnotating,
    setIsAnnotating,
    setViewingAnnotation,
    annotationCanvasRef,
    editAnnotationCanvasRef,
    fetchVersionComments,
    fetchAssets,
  });

  useEffect(() => {
    rangeDragCommitRef.current = (start, end) => {
      applyCommentRange(start, end, '');
    };
  }, [applyCommentRange]);

  const commentMarkers = useMemo<CommentMarker[]>(() => {
    return filteredComments.map((comment) => ({
      id: comment.id,
      timestamp: comment.timestamp,
      timestampEnd: comment.timestampEnd,
      color: comment.tag?.color || (comment.isResolved ? '#22C55E' : '#22D3EE'),
      preview: `${comment.tag ? ` [${comment.tag.name}]` : ''} - ${comment.content?.substring(0, 30) || '(voice note)'}...`,
      annotationData: comment.annotationData,
    }));
  }, [filteredComments]);

  const draftRange = useMemo(
    () =>
      draftRangeSpan(
        replyingTo
          ? { start: replyRangeStart, end: replyRangeEnd }
          : { start: commentRangeStart, end: commentRangeEnd },
        currentTime
      ),
    [commentRangeEnd, commentRangeStart, currentTime, replyRangeEnd, replyRangeStart, replyingTo]
  );

  const markActiveRangeIn = useCallback(() => {
    if (replyingTo) markReplyRangeIn();
    else markCommentRangeIn();
  }, [markCommentRangeIn, markReplyRangeIn, replyingTo]);

  const markActiveRangeOut = useCallback(() => {
    if (replyingTo) markReplyRangeOut();
    else markCommentRangeOut();
  }, [markCommentRangeOut, markReplyRangeOut, replyingTo]);

  const clearActiveRange = useCallback(() => {
    if (replyingTo) clearReplyRangeSelection();
    else clearCommentRangeSelection();
  }, [clearCommentRangeSelection, clearReplyRangeSelection, replyingTo]);

  const focusCommentComposer = useCallback(() => {
    setShowComments(true);
    setIsMobileCommentsOpen(true);
    window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
  }, [setIsMobileCommentsOpen, setShowComments]);

  const runReviewCommand = useCallback(
    (commandId: string) => {
      switch (commandId) {
        case 'mark-in':
          markActiveRangeIn();
          break;
        case 'mark-out':
          markActiveRangeOut();
          break;
        case 'clear-range':
          clearActiveRange();
          break;
        case 'focus-comment':
          focusCommentComposer();
          break;
        case 'toggle-play':
          handlePlayPause();
          break;
        case 'toggle-mute':
          handleMuteToggle();
          break;
        case 'toggle-fullscreen':
          toggleFullscreen();
          break;
        case 'record-voice':
          startRecording();
          break;
        case 'draw-annotation':
          if (playerRef.current?.pauseVideo) playerRef.current.pauseVideo();
          setIsAnnotating(true);
          break;
        case 'open-shortcuts-help':
          setReviewShortcutsOpen(true);
          break;
        case 'toggle-transcript':
          setTranscriptOpen((open) => !open);
          break;
      }
    },
    [
      clearActiveRange,
      focusCommentComposer,
      handleMuteToggle,
      handlePlayPause,
      markActiveRangeIn,
      markActiveRangeOut,
      startRecording,
      toggleFullscreen,
    ]
  );

  useReviewHotkeys({
    enabled: Boolean(video && activeVersion) && canInitializePlayer && !loading,
    paletteOpen: commandPaletteOpen,
    onTogglePalette: () => setCommandPaletteOpen((open) => !open),
    onMarkIn: markActiveRangeIn,
    onMarkOut: markActiveRangeOut,
    onClearRange: clearActiveRange,
    onFocusComment: focusCommentComposer,
    onOpenShortcutsHelp: () => setReviewShortcutsOpen(true),
    onToggleTranscript: () => setTranscriptOpen((open) => !open),
  });

  const editAnnotationInitialStrokes = useMemo<AnnotationStroke[] | undefined>(() => {
    if (editAnnotationData) {
      try {
        const parsed = JSON.parse(editAnnotationData);
        return (validateAnnotationStrokes(parsed) as AnnotationStroke[] | null) ?? undefined;
      } catch {
        return undefined;
      }
    }

    const editingComment = comments.find((comment) => comment.id === editingCommentId);
    if (!editingComment?.annotationData) return undefined;
    try {
      const parsed = JSON.parse(editingComment.annotationData);
      return (validateAnnotationStrokes(parsed) as AnnotationStroke[] | null) ?? undefined;
    } catch {
      return undefined;
    }
  }, [editAnnotationData, comments, editingCommentId]);

  useVersionDurationSync({
    videoDuration,
    activeVersionDuration,
    activeVersionId,
    propProjectId,
    videoId,
    setVideo,
  });

  const containerHeight = 'h-screen';
  const backHref =
    mode === 'dashboard'
      ? `/projects/${propProjectId}`
      : video?.projectId
        ? `/projects/${video.projectId}`
        : '/';
  const isBunnyVersion = activeVersion?.providerId === 'bunny';
  const showBunnyProcessingOverlay =
    isBunnyVersion && bunnyPlaybackState === 'processing' && !isReady;
  const isR2Version = activeVersion?.providerId === 'r2';
  const showBunnyErrorOverlay = (isBunnyVersion || isR2Version) && bunnyPlaybackState === 'error';

  const confirmGuestName = useCallback(() => {
    if (!guestName.trim()) return;
    localStorage.setItem('openframe_guest_name', guestName.trim());
    setGuestNameConfirmed(true);
  }, [guestName]);

  const handleDeleteCurrentVersionClick = useCallback(() => {
    setVersionToDelete(activeVersionId);
    setShowDeleteVersionDialog(true);
  }, [activeVersionId, setShowDeleteVersionDialog, setVersionToDelete]);

  const handleOpenCompare = useCallback(() => {
    setSelectedCompareVersions(new Set(activeVersionId ? [activeVersionId] : []));
    setShowCompareDialog(true);
  }, [activeVersionId]);

  const handleOpenApprovalRequestDialog = useCallback(() => {
    setApprovalError('');
    setShowApprovalRequestDialog(true);
  }, [setApprovalError]);

  const handleOpenApprovalsPanel = useCallback(() => {
    setApprovalError('');
    setShowApprovalsPanel(true);
    void fetchApprovalRequests();
  }, [fetchApprovalRequests, setApprovalError]);

  const toggleCompareVersion = useCallback((versionId: string) => {
    setSelectedCompareVersions((prev) => {
      const next = new Set(prev);
      if (next.has(versionId)) {
        next.delete(versionId);
      } else {
        next.add(versionId);
      }
      return next;
    });
  }, []);

  const handleCompareConfirm = useCallback(() => {
    const ids = Array.from(selectedCompareVersions).join(',');
    setShowCompareDialog(false);
    router.push(`/projects/${propProjectId}/videos/${videoId}/compare?versions=${ids}`);
  }, [propProjectId, router, selectedCompareVersions, videoId]);

  const handleStartEditAnnotation = useCallback(() => {
    if (playerRef.current?.pauseVideo) {
      playerRef.current.pauseVideo();
    }
    setIsEditingAnnotation(true);
    setIsAnnotating(false);
  }, [setIsEditingAnnotation]);

  const pauseVideoForAnnotation = useCallback(() => {
    if (playerRef.current?.pauseVideo) {
      playerRef.current.pauseVideo();
    }
  }, []);

  const headerActions: VideoPageHeaderActions = useMemo(
    () => ({
      onVersionSelect: handleVersionSelect,
      onDeleteCurrentVersionClick: handleDeleteCurrentVersionClick,
      onDownload: startDownload,
      onOpenCompare: handleOpenCompare,
      onCreateVersion: handleCreateVersion,
    }),
    [
      handleVersionSelect,
      handleDeleteCurrentVersionClick,
      startDownload,
      handleOpenCompare,
      handleCreateVersion,
    ]
  );

  const commentsActions: VideoPageCommentsActions = useMemo(
    () => ({
      onExportComments: exportComments,
      onResolveComment: handleResolveComment,
      onEditComment: handleEditComment,
      onDeleteComment: handleDeleteComment,
      onReplyComment: handleReplyComment,
      onSubmitReplyWithMedia: submitReplyWithMedia,
      onStartEditAnnotation: handleStartEditAnnotation,
    }),
    [
      exportComments,
      handleResolveComment,
      handleEditComment,
      handleDeleteComment,
      handleReplyComment,
      submitReplyWithMedia,
      handleStartEditAnnotation,
    ]
  );

  const composerActions: VideoPageComposerActions = useMemo(
    () => ({
      onSubmitCommentWithMedia: submitCommentWithMedia,
      onAddComment: handleAddComment,
      onPauseVideoForAnnotation: pauseVideoForAnnotation,
    }),
    [submitCommentWithMedia, handleAddComment, pauseVideoForAnnotation]
  );

  const compareActions: VideoPageCompareActions = useMemo(
    () => ({
      onToggleVersion: toggleCompareVersion,
      onCompare: handleCompareConfirm,
    }),
    [toggleCompareVersion, handleCompareConfirm]
  );

  const handleTranscriptSeek = useCallback(
    (seconds: number, options?: { pauseAfterSeek?: boolean; timestampEnd?: number | null }) => {
      handleSeekToTimestamp(seconds, undefined, options);
    },
    [handleSeekToTimestamp]
  );

  const handleTranscriptCommentRange = useCallback(
    (start: number, end: number, quote: string) => {
      applyCommentRange(start, end, quote);
    },
    [applyCommentRange]
  );

  const handleOpenTranscriptThread = useCallback((commentId: string) => {
    setFocusCommentId(commentId);
    setActiveSidePane('comments');
  }, []);

  const transcriptCommentMarkers = useMemo(
    () =>
      comments.map((comment) => ({
        id: comment.id,
        timestamp: comment.timestamp,
        timestampEnd: comment.timestampEnd,
        content: comment.content,
        authorName: comment.author?.name || comment.guestName || 'Anonymous',
        authorImage: comment.author?.image ?? null,
        color: comment.tag?.color ?? null,
      })),
    [comments]
  );

  if (loading) {
    return (
      <VideoPageLoading
        containerHeight={containerHeight}
        mode={mode}
        isFullscreenMode={isFullscreenMode}
        cursorIdle={cursorIdle}
        isPlaying={isPlaying}
        showComments={showComments}
      />
    );
  }

  if (error || !video || !activeVersion) {
    return (
      <VideoPageError
        containerHeight={containerHeight}
        error={error}
        mode={mode}
        projectId={propProjectId}
      />
    );
  }

  if (mode === 'watch' && isGuest && !guestNameConfirmed) {
    return (
      <GuestNameGate
        guestName={guestName}
        setGuestName={setGuestName}
        onConfirm={confirmGuestName}
      />
    );
  }

  return (
    <div
      className={cn(
        containerHeight,
        'dark flex flex-col bg-[#0D0E11] text-foreground overflow-hidden'
      )}
    >
      <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden min-h-0">
        <TranscriptSidebar
          open={transcriptOpen}
          onClose={() => setTranscriptOpen(false)}
          isFullscreen={isFullscreenMode}
        >
          <TranscriptPane
            versionId={activeVersionId}
            getCurrentTime={getCurrentTime}
            canManage={canManageCaptions}
            comments={transcriptCommentMarkers}
            draftRange={
              commentRangeStart !== null && commentRangeEnd !== null
                ? { start: commentRangeStart, end: commentRangeEnd }
                : null
            }
            onSeek={handleTranscriptSeek}
            onCommentRange={handleTranscriptCommentRange}
            onOpenThread={handleOpenTranscriptThread}
          />
        </TranscriptSidebar>
        <div className={cn('flex-1 w-full flex flex-col min-h-0', isFullscreenMode && 'relative')}>
          <VideoPageHeader
            mode={mode}
            backHref={backHref}
            title={video.title}
            projectName={video.project.name}
            isFullscreenMode={isFullscreenMode}
            cursorIdle={cursorIdle}
            isPlaying={isPlaying}
            versions={video.versions}
            activeVersion={activeVersion}
            activeVersionId={activeVersionId}
            onVersionSelect={headerActions.onVersionSelect}
            onDeleteCurrentVersionClick={headerActions.onDeleteCurrentVersionClick}
            showDeleteVersionDialog={showDeleteVersionDialog}
            setShowDeleteVersionDialog={setShowDeleteVersionDialog}
            isDeletingVersion={isDeletingVersion}
            onDeleteVersion={handleDeleteVersion}
            videoCanDownload={!!video.canDownload}
            isDownloadingVideo={isDownloadingVideo}
            activeDownloadTarget={activeDownloadTarget}
            onDownload={headerActions.onDownload}
            projectId={projectId}
            videoId={videoId}
            directUploadsEnabled={directUploadsEnabled}
            showVersionDialog={showVersionDialog}
            setShowVersionDialog={setShowVersionDialog}
            newVersionMode={newVersionMode}
            setNewVersionMode={setNewVersionMode}
            newVersionUrl={newVersionUrl}
            handleNewVersionUrlChange={handleNewVersionUrlChange}
            newVersionUrlError={newVersionUrlError}
            newVersionSource={newVersionSource}
            newVersionFile={newVersionFile}
            setNewVersionFile={setNewVersionFile}
            newVersionLabel={newVersionLabel}
            setNewVersionLabel={setNewVersionLabel}
            newVersionUploadStatus={newVersionUploadStatus}
            newVersionUploadProgress={newVersionUploadProgress}
            isCreatingVersion={isCreatingVersion}
            onCreateVersion={headerActions.onCreateVersion}
            onOpenCompare={headerActions.onOpenCompare}
            canRequestApproval={canRequestApproval}
            canShareVideo={canShareVideo}
            hasPendingApprovalRequest={!!activePendingRequest}
            onOpenApprovalRequest={handleOpenApprovalRequestDialog}
            onOpenApprovalsPanel={handleOpenApprovalsPanel}
            transcriptOpen={transcriptOpen}
            onToggleTranscript={() => setTranscriptOpen((open) => !open)}
          />

          {!isFullscreenMode && (
            <VideoMetadataFields
              projectId={video.projectId}
              videoId={video.id}
              metadata={video.metadata ?? {}}
              canEdit={!!video.canShareVideo}
              onSaved={(next) => {
                setVideo((prev) => (prev ? { ...prev, metadata: next } : prev));
              }}
            />
          )}

          {(video.kind ?? 'VIDEO') === 'VIDEO' &&
            (activeVersion.proxyStatus === 'PENDING' ||
              activeVersion.proxyStatus === 'RUNNING') && (
              <p className="text-sm text-muted-foreground px-4 pt-2">
                Preparing a review proxy so this file can play in the browser…
              </p>
            )}

          <PlayerCore
            activeVersionId={activeVersionId}
            activeProviderId={activeVersion?.providerId}
            reviewKind={video.kind ?? 'VIDEO'}
            embedUrl={embedUrl}
            videoRef={videoRef}
            iframeRef={iframeRef}
            bunnyViewportRef={bunnyViewportRef}
            timelineRef={timelineRef}
            progressRef={progressRef}
            playheadRef={playheadRef}
            scrubReadoutRef={scrubReadoutRef}
            videoContainerRef={videoContainerRef}
            showScrubReadout={showScrubReadout}
            isFullscreenMode={isFullscreenMode}
            cursorIdle={cursorIdle}
            isPlaying={isPlaying}
            handlePlayPause={handlePlayPause}
            handleVideoMouseMove={handleVideoMouseMove}
            handleVideoMouseLeave={handleVideoMouseLeave}
            isBunnyPortraitSource={isBunnyPortraitSource}
            bunnyPortraitFrameWidth={bunnyPortraitFrameWidth}
            showBunnyProcessingOverlay={showBunnyProcessingOverlay}
            showBunnyErrorOverlay={showBunnyErrorOverlay}
            showResumePrompt={showResumePrompt}
            savedProgress={savedProgress}
            formatTime={formatTime}
            handleResumeFromSaved={handleResumeFromSavedWithSync}
            handleDismissResume={handleDismissResume}
            isAnnotating={isAnnotating}
            annotationCanvasRef={annotationCanvasRef}
            setAnnotationStrokes={setAnnotationStrokes}
            setIsAnnotating={setIsAnnotating}
            setViewingAnnotation={setViewingAnnotation}
            viewingAnnotation={viewingAnnotation}
            isEditingAnnotation={isEditingAnnotation}
            editAnnotationCanvasRef={editAnnotationCanvasRef}
            editAnnotationInitialStrokes={editAnnotationInitialStrokes}
            setEditAnnotationData={setEditAnnotationData}
            setIsEditingAnnotation={setIsEditingAnnotation}
            currentTime={currentTime}
            duration={duration}
            isFrameMode={isFrameMode}
            frameStepLabel={frameStepLabel}
            estimatedFrameRate={estimatedFrameRate}
            handleSkip={handleSkip}
            handleFrameModeToggle={handleFrameModeToggle}
            handleMuteToggle={handleMuteToggle}
            isMuted={isMuted}
            selectedQualityLabel={selectedQualityLabel}
            selectedQualityLevel={selectedQualityLevel}
            qualityOptions={qualityOptions}
            handleQualityChange={handleQualityChange}
            subtitles={subtitles}
            subtitleTracks={subtitleTracks}
            subtitleTrackKey={subtitleTrackKey}
            activeSubtitleLanguage={activeCaptionLanguage}
            onSelectSubtitleLanguage={selectCaptionLanguage}
            canManageSubtitles={canManageCaptions}
            canGenerateSubtitles={canGenerateCaptions}
            onUploadSubtitle={uploadSubtitle}
            onDeleteSubtitle={deleteSubtitle}
            onGenerateSubtitles={generateSubtitles}
            isUploadingSubtitle={isUploadingSubtitle}
            isGeneratingSubtitles={isGeneratingSubtitles}
            playbackSpeed={playbackSpeed}
            playbackSpeedBounds={playbackSpeedBounds}
            handleSpeedNudge={handleSpeedNudge}
            toggleFullscreen={toggleFullscreen}
            showComments={showComments}
            setShowComments={setShowComments}
            setIsMobileCommentsOpen={setIsMobileCommentsOpen}
            handleTimelineMouseDown={handleTimelineMouseDown}
            handleTimelineMouseMove={handleTimelineMouseMove}
            handleSeekToTimestamp={handleSeekToTimestamp}
            commentMarkers={commentMarkers}
            draftRange={draftRange}
            commentRangeStart={replyingTo ? replyRangeStart : commentRangeStart}
            commentRangeEnd={replyingTo ? replyRangeEnd : commentRangeEnd}
            markCommentRangeIn={markActiveRangeIn}
            markCommentRangeOut={markActiveRangeOut}
            clearCommentRangeSelection={clearActiveRange}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            reviewWatermark={reviewWatermark}
          />
        </div>

        <CommentsPane
          isMobileCommentsOpen={isMobileCommentsOpen}
          setIsMobileCommentsOpen={setIsMobileCommentsOpen}
          isFullscreenMode={isFullscreenMode}
          showComments={showComments}
          comments={comments}
          filteredComments={filteredComments}
          sortedComments={sortedComments}
          showResolved={showResolved}
          handleToggleShowResolved={handleToggleShowResolved}
          activeVersion={activeVersion}
          isGuest={isGuest}
          isExportingCsv={isExportingCsv}
          isExportingPdf={isExportingPdf}
          handleExportComments={commentsActions.onExportComments}
          canResolveComments={canResolveComments}
          handleResolveComment={commentsActions.onResolveComment}
          handleSeekToTimestamp={handleSeekToTimestamp}
          currentUserId={currentUserId}
          projectOwnerId={video.project.ownerId}
          editingCommentId={editingCommentId}
          startEditingComment={startEditingComment}
          startEditingReply={startEditingReply}
          cancelEditingComment={cancelEditingComment}
          editText={editText}
          setEditText={setEditText}
          editTagId={editTagId}
          setEditTagId={setEditTagId}
          editImageUrls={editImageUrls}
          editImageFiles={editImageFiles}
          editImageInputRef={editImageInputRef}
          removeEditImageUrl={removeEditImageUrl}
          onStartEditAnnotation={commentsActions.onStartEditAnnotation}
          isSubmittingEdit={isSubmittingEdit}
          availableTags={availableTags}
          handleEditComment={commentsActions.onEditComment}
          handleDeleteComment={commentsActions.onDeleteComment}
          playVoice={playVoice}
          playingVoiceId={playingVoiceId}
          voiceProgress={voiceProgress}
          voiceCurrentTime={voiceCurrentTime}
          voicePlaybackRate={voicePlaybackRate}
          toggleVoiceSpeed={toggleVoiceSpeed}
          formatTime={formatTime}
          setPreviewImage={setPreviewImage}
          replyingTo={replyingTo}
          setReplyingTo={setReplyingTo}
          replyText={replyText}
          setReplyText={setReplyText}
          replyRangeStart={replyRangeStart}
          replyRangeEnd={replyRangeEnd}
          markReplyRangeIn={markReplyRangeIn}
          markReplyRangeOut={markReplyRangeOut}
          seekToReplyRangeIn={
            replyRangeStart !== null ? () => handleSeekToTimestamp(replyRangeStart) : undefined
          }
          seekToReplyRangeOut={
            replyRangeEnd !== null ? () => handleSeekToTimestamp(replyRangeEnd) : undefined
          }
          clearReplyRangeSelection={clearReplyRangeSelection}
          handleReplyComment={commentsActions.onReplyComment}
          startReplyRecording={startReplyRecording}
          isReplyRecording={isReplyRecording}
          replyRecordingTime={replyRecordingTime}
          stopReplyRecording={stopReplyRecording}
          cancelReplyRecording={cancelReplyRecording}
          replyAudioBlob={replyAudioBlob}
          replyImageFiles={replyImageFiles}
          replyImageInputRef={replyImageInputRef}
          removeImageFile={removeImageFile}
          handleImageSelect={handleImageSelect}
          handlePaste={handlePaste}
          handleDrop={handleDrop}
          submitReplyWithMedia={commentsActions.onSubmitReplyWithMedia}
          isSubmittingReply={isSubmittingReply}
          isUploadingReplyAudio={isUploadingReplyAudio}
          isUploadingReplyImage={isUploadingReplyImage}
          assets={assets}
          onAssetMentionClick={handleAssetMentionClick}
          activePane={activeSidePane}
          setActivePane={setActiveSidePane}
          focusCommentId={focusCommentId}
          onFocusCommentHandled={() => setFocusCommentId(null)}
          assetsPane={
            <AssetsPane
              videoId={videoId}
              assets={assets}
              isLoadingAssets={isLoadingAssets}
              isCreatingAsset={isCreatingAsset}
              deletingAssetIds={deletingAssetIds}
              activeDownloadAssetId={activeDownloadAssetId}
              canUploadAssets={canUploadAssets}
              canDownloadAssets={canDownloadAssets}
              getGuestUploadToken={getGuestUploadToken}
              createAsset={createAsset}
              deleteAsset={deleteAsset}
              downloadAsset={downloadAsset}
              hasMoreAssets={hasMoreAssets}
              isLoadingMoreAssets={isLoadingMoreAssets}
              loadMoreAssets={loadMoreAssets}
              highlightedAssetId={highlightedAssetId}
              onHighlightedAssetHandled={() => setHighlightedAssetId(null)}
              directUploadProvider={directUploadProvider}
            />
          }
          agentsEnabled={agentsEnabled}
          canManageAgentComments={canManageAgentComments}
          agentRunBusy={agentRunBusy}
          agentRunError={agentRunError}
          onRunAgentReview={handleRunAgentReview}
          composer={
            <CommentComposer
              isRecording={isRecording}
              recordingTime={recordingTime}
              stopRecording={stopRecording}
              cancelRecording={cancelRecording}
              audioBlob={audioBlob}
              imageFiles={imageFiles}
              imageInputRef={imageInputRef}
              removeImageFile={(index) => removeImageFile(index, 'comment')}
              commentText={commentText}
              setCommentText={setCommentText}
              commentRangeStart={commentRangeStart}
              commentRangeEnd={commentRangeEnd}
              markCommentRangeIn={markCommentRangeIn}
              markCommentRangeOut={markCommentRangeOut}
              seekToCommentRangeIn={
                commentRangeStart !== null
                  ? () => handleSeekToTimestamp(commentRangeStart)
                  : undefined
              }
              seekToCommentRangeOut={
                commentRangeEnd !== null ? () => handleSeekToTimestamp(commentRangeEnd) : undefined
              }
              clearCommentRangeSelection={clearCommentRangeSelection}
              playVoice={playVoice}
              playingVoiceId={playingVoiceId}
              voiceProgress={voiceProgress}
              voiceCurrentTime={voiceCurrentTime}
              formatTime={formatTime}
              toggleVoiceSpeed={toggleVoiceSpeed}
              voicePlaybackRate={voicePlaybackRate}
              submitCommentWithMedia={composerActions.onSubmitCommentWithMedia}
              isUploadingAudio={isUploadingAudio}
              isUploadingImage={isUploadingImage}
              annotationStrokes={annotationStrokes}
              isAnnotating={isAnnotating}
              setAnnotationStrokes={setAnnotationStrokes}
              setIsAnnotating={setIsAnnotating}
              handleAddComment={composerActions.onAddComment}
              isSubmittingComment={isSubmittingComment}
              startRecording={startRecording}
              handlePaste={handlePaste}
              handleImageSelect={handleImageSelect}
              availableTags={availableTags}
              selectedTagId={selectedTagId}
              setSelectedTagId={setSelectedTagId}
              canManageTags={!!video.canManageTags}
              projectId={projectId}
              pauseVideoForAnnotation={composerActions.onPauseVideoForAnnotation}
              assets={assets}
              composerTextareaRef={composerTextareaRef}
            />
          }
        />
      </div>

      {commandPaletteOpen ? (
        <ReviewCommandPalette open onOpenChange={setCommandPaletteOpen} onRun={runReviewCommand} />
      ) : null}
      <KeyboardShortcutsModal
        open={reviewShortcutsOpen}
        onOpenChange={setReviewShortcutsOpen}
        variant="review"
      />

      <ImagePreviewDialog previewImage={previewImage} onClose={() => setPreviewImage(null)} />

      <CompareVersionsDialog
        open={showCompareDialog}
        onOpenChange={setShowCompareDialog}
        versions={video.versions}
        selectedCompareVersions={selectedCompareVersions}
        onToggleVersion={compareActions.onToggleVersion}
        onCompare={compareActions.onCompare}
      />

      {mode === 'dashboard' ? (
        <>
          <ApprovalRequestDialog
            open={showApprovalRequestDialog}
            onOpenChange={setShowApprovalRequestDialog}
            candidates={approvalCandidates}
            currentUserId={currentUserId}
            activePendingRequest={activePendingRequest}
            isLoadingCandidates={isLoadingApprovalCandidates}
            isSubmittingRequest={isSubmittingApprovalRequest}
            error={approvalError}
            onRefreshCandidates={fetchApprovalCandidates}
            onCreateRequest={createApprovalRequest}
          />
          <ApprovalRequestsPanel
            open={showApprovalsPanel}
            onOpenChange={setShowApprovalsPanel}
            requests={approvalRequests}
            currentUserId={currentUserId}
            canRequestApproval={canRequestApproval}
            onOpenApprovalRequest={handleOpenApprovalRequestDialog}
            isLoadingRequests={isLoadingApprovals}
            isSubmittingDecision={isSubmittingApprovalDecision}
            isCancelingRequest={isCancelingApprovalRequest}
            error={approvalError}
            onRefresh={fetchApprovalRequests}
            onSubmitDecision={submitApprovalDecision}
            onCancelRequest={cancelApprovalRequest}
          />
        </>
      ) : null}
    </div>
  );
}
