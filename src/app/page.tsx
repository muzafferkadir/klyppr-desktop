'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { translations } from '@/locales/translations';
import { FFmpegService, SilentSegment } from '@/services/ffmpeg';

// Initialize FFmpegService
const ffmpegService = FFmpegService.getInstance();

export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [silentSegments, setSilentSegments] = useState<SilentSegment[]>([]);
  const [progress, setProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(-45);
  const [minDuration, setMinDuration] = useState(0.6);
  const [padding, setPadding] = useState(0.05);
  const [videoDuration, setVideoDuration] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [isSegmentsOpen, setIsSegmentsOpen] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string>('');
  const [lang, setLang] = useState<'tr' | 'en'>('en');
  const t = translations[lang];
  const detectButtonRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [maxFileSize, setMaxFileSize] = useState<number>(0);
  const [processingTimes, setProcessingTimes] = useState<{
    detection: number;
    trimming: number;
  }>({ detection: 0, trimming: 0 });
  const [systemMetrics, setSystemMetrics] = useState<{
    cpu: number;
    memory: number;
    estimatedTimeLeft: number;
    originalSize: number;
    processedSize: number;
  }>({
    cpu: 0,
    memory: 0,
    estimatedTimeLeft: 0,
    originalSize: 0,
    processedSize: 0
  });

  // Performance test function
  const testPerformance = useCallback(async () => {
    try {
      const memory = (navigator as any).deviceMemory || 4;
      const cores = navigator.hardwareConcurrency || 4;
      
      const baseSize = 100;
      const memoryFactor = memory / 4;
      const coreFactor = cores / 4;
      
      const calculatedSize = Math.floor(baseSize * Math.min(memoryFactor, coreFactor));
      const maxSize = Math.min(Math.max(calculatedSize, 50), 500);
      setMaxFileSize(maxSize);
      
      console.log(`Device capabilities: ${memory}GB RAM, ${cores} cores`);
      console.log(`Calculated max file size: ${maxSize}MB`);
    } catch (error) {
      console.error('Error testing performance:', error);
      setMaxFileSize(100);
    }
  }, []);

  useEffect(() => {
    testPerformance();
  }, [testPerformance]);

  const handleVideoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      console.log('Selected file:', file);
      
      const fileSizeMB = file.size / (1024 * 1024);
      if (fileSizeMB > maxFileSize) {
        const shouldContinue = window.confirm(
          `${t.fileSizeWarning} (${Math.round(fileSizeMB)}MB > ${maxFileSize}MB)\n\n${t.continueAnyway}`
        );
        if (!shouldContinue) {
          return;
        }
        setLogs([`${t.fileSizeWarning} (${Math.round(fileSizeMB)}MB > ${maxFileSize}MB)`]);
      } else {
        setLogs([]);
      }

      // Get the file path using Electron's dialog
      const filePath = (file as any).path;
      if (!filePath) {
        console.error('Could not get file path');
        setLogs(prev => [...prev, 'Could not get file path']);
        return;
      }

      console.log('File path:', filePath);
      setVideo({ ...file, path: filePath });
      setSilentSegments([]);
      setProgress(0);
      setProcessingTimes({ detection: 0, trimming: 0 });

      const url = URL.createObjectURL(file);
      setPreviewUrl(url);

      const video = document.createElement('video');
      video.src = url;
      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          setVideoDuration(video.duration);
          video.currentTime = 0;
          resolve(null);
        };
      });

      await new Promise((resolve) => {
        video.onseeked = () => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL());
          resolve(null);
        };
      });

      setTimeout(() => {
        detectButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  };

  const scrollToProgress = () => {
    setTimeout(() => {
      progressRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  const detectSilence = async () => {
    if (!video) return;
    
    scrollToProgress();
    const startTime = performance.now();
    
    try {
      setProcessing(true);
      setProgress(0);
      setLogs([t.detectingSilence]);
      
      console.log('Starting silence detection for file:', video);
      const filePath = (video as any).path;
      if (!filePath) {
        throw new Error('Could not get file path');
      }

      const segments = await window.electron.detectSilence({
        filePath,
        threshold,
        minDuration
      });
      console.log('Detected segments:', segments);

      if (segments.length === 0) {
        setLogs(prev => [...prev, t.noSilenceFound]);
        return;
      }

      setLogs(prev => [...prev, `${segments.length}${t.silenceFound}`]);
      setSilentSegments(segments);

    } catch (err) {
      const error = err as Error;
      console.error('Silence detection error:', error);
      setLogs(prev => [...prev, `${t.error}${error.message}`]);
    } finally {
      setProcessing(false);
      const endTime = performance.now();
      setProcessingTimes(prev => ({
        ...prev,
        detection: (endTime - startTime) / 1000
      }));
    }
  };

  const trimSilence = async () => {
    if (!video || silentSegments.length === 0) return;
    
    scrollToProgress();
    const startTime = performance.now();
    
    try {
      setProcessing(true);
      setProgress(0);
      setLogs([t.trimmingSilence]);

      // Set up progress listener before starting the operation
      window.electron.onProgress((progress: number) => {
        console.log('Progress in UI:', progress);
        setProgress(progress);
      });

      const filePath = (video as any).path;
      if (!filePath) {
        throw new Error('Could not get file path');
      }

      const outputPath = await ffmpegService.trimSilence(filePath, silentSegments);
      console.log('Output path:', outputPath);
      
      // Open the file using Electron's shell
      await window.electron.openFile(outputPath);
      
      setLogs(prev => [...prev, t.trimComplete]);
    } catch (err) {
      const error = err as Error;
      console.error('Trimming error:', error);
      setLogs(prev => [...prev, `${t.error}${error.message}`]);
    } finally {
      setProcessing(false);
      const endTime = performance.now();
      setProcessingTimes(prev => ({
        ...prev,
        trimming: (endTime - startTime) / 1000
      }));
    }
  };

  // Monitor system performance
  const updateSystemMetrics = useCallback(async () => {
    try {
      // Get memory usage
      const memory = (performance as any).memory;
      const usedMemory = memory ? (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100 : 0;

      // Estimate CPU usage based on processing time
      const cpuUsage = processing ? Math.min((progress + 20), 100) : 0;

      setSystemMetrics(prev => ({
        ...prev,
        cpu: Math.round(cpuUsage),
        memory: Math.round(usedMemory)
      }));
    } catch (error) {
      console.error('Error updating metrics:', error);
    }
  }, [progress, processing]);

  useEffect(() => {
    const interval = setInterval(updateSystemMetrics, 1000);
    return () => clearInterval(interval);
  }, [updateSystemMetrics]);

  // Calculate estimated time left
  const updateEstimatedTime = useCallback((currentProgress: number) => {
    if (currentProgress > 0 && processing) {
      const elapsedTime = (performance.now() - startTimeRef.current) / 1000;
      const estimatedTotal = (elapsedTime * 100) / currentProgress;
      const timeLeft = Math.max(0, estimatedTotal - elapsedTime);
      
      setSystemMetrics(prev => ({
        ...prev,
        estimatedTimeLeft: Math.round(timeLeft)
      }));
    }
  }, [processing]);

  // Add startTimeRef for time tracking
  const startTimeRef = useRef<number>(0);

  // Add PerformanceMetrics component
  const PerformanceMetrics = () => (
    <div className="bg-gray-800/50 backdrop-blur-sm rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>
          <span className="text-xs text-gray-300">{t.cpuUsage}</span>
        </div>
        <div className="w-24 bg-gray-700 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${systemMetrics.cpu}%` }}
          />
        </div>
        <span className="text-xs text-gray-400">{systemMetrics.cpu}%</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-xs text-gray-300">{t.memoryUsage}</span>
        </div>
        <div className="w-24 bg-gray-700 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${systemMetrics.memory}%` }}
          />
        </div>
        <span className="text-xs text-gray-400">{systemMetrics.memory}%</span>
      </div>

      {processing && systemMetrics.estimatedTimeLeft > 0 && (
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs text-gray-300">
            {t.estimatedTimeLeft}: {Math.round(systemMetrics.estimatedTimeLeft)}s
          </span>
        </div>
      )}
    </div>
  );

  // Add ProcessingSummary component
  const ProcessingSummary = () => {
    if (!systemMetrics.originalSize || !systemMetrics.processedSize) return null;

    const originalMB = (systemMetrics.originalSize / (1024 * 1024)).toFixed(1);
    const processedMB = (systemMetrics.processedSize / (1024 * 1024)).toFixed(1);
    const reduction = Math.abs(((systemMetrics.originalSize - systemMetrics.processedSize) / systemMetrics.originalSize * 100)).toFixed(1);
    const isReduced = systemMetrics.processedSize < systemMetrics.originalSize;

    return (
      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-200">{t.processingSummary}</h3>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div className="space-y-1">
            <p className="text-gray-400">{t.originalSize}</p>
            <p className="text-gray-200">{originalMB} MB</p>
          </div>
          <div className="space-y-1">
            <p className="text-gray-400">{t.processedSize}</p>
            <p className="text-gray-200">{processedMB} MB</p>
          </div>
          <div className="space-y-1">
            <p className="text-gray-400">{t.sizeReduction}</p>
            <p className={isReduced ? "text-green-400" : "text-red-400"}>{reduction}%</p>
          </div>
          <div className="space-y-1">
            <p className="text-gray-400">{t.processingTime}</p>
            <p className="text-gray-200">{processingTimes.detection + processingTimes.trimming}s</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-gray-100">
      {/* Language Selector */}
      <div className="absolute top-2 right-2 z-50 flex flex-row items-center gap-1">
        <button
          onClick={() => setLang('tr')}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all transform hover:scale-110 ${
            lang === 'tr' ? 'bg-blue-600 text-white ring-2 ring-blue-400 shadow-lg' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          🇹🇷
        </button>
        <button
          onClick={() => setLang('en')}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all transform hover:scale-110 ${
            lang === 'en' ? 'bg-blue-600 text-white ring-2 ring-blue-400 shadow-lg' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          🇬🇧
        </button>
      </div>

      <div className="p-4 sm:p-6 md:p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-center flex items-center justify-center gap-3 px-4 pt-2">
            {/* <div className="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 relative group">
              <img
                src="/logo.png"
                alt="Klyppr Logo"
                className="w-full h-full object-contain"
              />
              <div className="absolute inset-0 bg-gradient-to-br from-blue-400/5 to-purple-400/5 rounded-lg group-hover:from-blue-400/10 group-hover:to-purple-400/10 transition-all duration-300"></div>
            </div> */}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">
              {t.title}
            </span>
          </h1>

          {/* Main Content */}
          <div className="space-y-4 sm:space-y-6">
            {/* First Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              {/* Video Upload Section */}
              <div className="bg-gray-800/50 backdrop-blur-sm p-3 sm:p-4 md:p-6 rounded-xl shadow-lg border border-gray-700/50">
                <div className="flex flex-col gap-3 sm:gap-4">
                  {/* Video Selection Button */}
                  <label className="w-full cursor-pointer bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white p-4 sm:p-6 md:p-8 rounded-lg transition-all shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]">
                    <span className="flex items-center justify-center gap-2 sm:gap-3 text-base sm:text-lg font-medium">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 sm:h-8 sm:w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      {t.selectVideo}
                    </span>
                    <input
                      type="file"
                      accept="video/*"
                      onChange={handleVideoChange}
                      className="hidden"
                    />
                  </label>

                  {/* Max File Size Info */}
                  <div className="text-center space-y-2 p-2 bg-gray-700/50 rounded-lg">
                    <div className="flex items-center justify-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-[11px] sm:text-xs text-gray-300">
                        <span className="font-medium text-blue-400">{maxFileSize}MB</span> {t.maxFileSizeInfo}
                      </p>
                    </div>
                    <p className="text-[10px] sm:text-xs text-gray-400 leading-relaxed">
                      {t.deviceBasedLimit}
                    </p>
                  </div>

                  {/* Thumbnail and Info */}
                  {video && (
                    <div className="flex items-center gap-3 sm:gap-4">
                      <div className="w-20 h-20 sm:w-24 sm:h-24 md:w-32 md:h-32 flex-shrink-0 bg-gray-700 rounded-lg overflow-hidden ring-2 ring-gray-600/30">
                        {thumbnailUrl && (
                          <img
                            src={thumbnailUrl}
                            alt="Video thumbnail"
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                      <div className="flex-grow min-w-0">
                        <div className="space-y-1 sm:space-y-2">
                          <p className="font-medium text-gray-200 truncate text-sm sm:text-base">{video.name}</p>
                          <p className="text-xs sm:text-sm text-gray-400">{t.duration}: {videoDuration.toFixed(1)}s</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Detection Controls */}
              <div className="bg-gray-800 p-3 sm:p-4 md:p-6 rounded-xl shadow-lg space-y-4 sm:space-y-6">
                <div className="space-y-3 sm:space-y-4">
                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-gray-200 mb-1">
                      {t.audioThreshold}: {threshold}dB
                    </label>
                    <input
                      type="range"
                      min="-60"
                      max="-10"
                      value={threshold}
                      onChange={(e) => setThreshold(parseInt(e.target.value))}
                      className="w-full h-1.5 sm:h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>-60dB ({t.sensitive})</span>
                      <span>-10dB ({t.rough})</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-gray-200 mb-1">
                      {t.minSilenceDuration}: {minDuration}s
                    </label>
                    <input
                      type="range"
                      min="0.1"
                      max="2"
                      step="0.1"
                      value={minDuration}
                      onChange={(e) => setMinDuration(parseFloat(e.target.value))}
                      className="w-full h-1.5 sm:h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>0.1s ({t.short})</span>
                      <span>2.0s ({t.long})</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs sm:text-sm font-medium text-gray-200 mb-1">
                      {t.padding}: {padding}s
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="0.5"
                      step="0.05"
                      value={padding}
                      onChange={(e) => setPadding(parseFloat(e.target.value))}
                      className="w-full h-1.5 sm:h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>0s</span>
                      <span>0.5s</span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-center">
                  <button
                    ref={detectButtonRef}
                    onClick={detectSilence}
                    disabled={processing || !video}
                    className="flex items-center gap-2 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white px-6 sm:px-8 md:px-10 py-3 sm:py-4 md:py-5 rounded-lg transition-all shadow-lg hover:shadow-xl text-base sm:text-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 md:h-7 md:w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    {t.detectSilence}
                  </button>
                </div>
              </div>
            </div>

            {/* Timeline Section */}
            {video && (
              <div className="bg-gray-800 p-3 sm:p-4 md:p-6 rounded-xl shadow-lg space-y-4">
                <div className="relative">
                  {/* Current Time Display */}
                  <div className="text-center mb-2">
                    <span className="text-xs sm:text-sm text-gray-400">
                      {t.duration}: {videoDuration.toFixed(1)}s
                    </span>
                  </div>

                  {/* Timeline Bar */}
                  <div className="h-16 sm:h-20 bg-gray-700 rounded-lg relative">
                    {silentSegments.map((segment, index) => {
                      const startPercent = (segment.start / videoDuration) * 100;
                      const widthPercent = ((segment.end - segment.start) / videoDuration) * 100;
                      return (
                        <div
                          key={index}
                          className="absolute h-full bg-red-500/30 backdrop-blur-sm"
                          style={{
                            left: `${startPercent}%`,
                            width: `${widthPercent}%`,
                          }}
                        />
                      );
                    })}
                    
                    {/* Time markers - Only show on larger screens */}
                    <div className="absolute top-0 left-0 w-full h-full hidden sm:flex justify-between px-2">
                      {Array.from({ length: 11 }).map((_, i) => (
                        <div key={i} className="h-full flex flex-col justify-center items-center">
                          <div className="h-full w-px bg-gray-600"></div>
                          <span className="text-xs text-gray-400 mt-1">
                            {((videoDuration * i) / 10).toFixed(1)}s
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Mobile Time markers - Simplified */}
                    <div className="absolute top-0 left-0 w-full h-full flex sm:hidden justify-between px-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="h-full flex flex-col justify-center items-center">
                          <div className="h-full w-px bg-gray-600"></div>
                          <span className="text-[10px] text-gray-400 mt-1">
                            {((videoDuration * i) / 4).toFixed(0)}s
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Trim Button */}
                {silentSegments.length > 0 && (
                  <div className="flex justify-center">
                    <button
                      onClick={trimSilence}
                      disabled={processing}
                      className="flex items-center gap-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white px-6 sm:px-8 md:px-10 py-3 sm:py-4 md:py-5 rounded-lg transition-all shadow-lg hover:shadow-xl text-base sm:text-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 md:h-7 md:w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {t.trimSilence}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Detected Segments */}
            {silentSegments.length > 0 && (
              <div className="bg-gray-800 rounded-xl shadow-lg overflow-hidden">
                <button
                  onClick={() => setIsSegmentsOpen(!isSegmentsOpen)}
                  className="w-full p-3 sm:p-4 flex items-center justify-between text-left hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className={`h-4 w-4 sm:h-5 sm:w-5 transform transition-transform ${isSegmentsOpen ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-semibold text-gray-200 text-sm sm:text-base">
                      {t.detectedSegments} ({silentSegments.length})
                    </span>
                  </div>
                </button>

                {isSegmentsOpen && (
                  <div className="border-t border-gray-700 p-3 sm:p-4">
                    <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
                      {silentSegments.map((segment, index) => (
                        <div
                          key={index}
                          className="bg-gray-700 p-1.5 sm:p-2 rounded-lg text-xs border border-gray-600 hover:border-blue-500/50 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-0.5 sm:mb-1">
                            <span className="text-blue-400 font-bold text-[10px] sm:text-xs">{(segment.end - segment.start).toFixed(1)}s</span>
                          </div>
                          <div className="flex justify-between text-gray-300 text-[8px] sm:text-[10px]">
                            <div className="text-center">
                              <div>{segment.start.toFixed(1)}s</div>
                            </div>
                            <div className="text-center">
                              <div>{segment.end.toFixed(1)}s</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Progress Bar */}
            {processing && (
              <div ref={progressRef} className="bg-gray-800 p-3 sm:p-4 rounded-xl shadow-lg">
                <div className="h-1.5 sm:h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-2 text-center text-xs sm:text-sm text-gray-400">
                  {t.processing}... {Math.round(progress)}%
                </div>
              </div>
            )}

            {/* Logs Section */}
            {logs.length > 0 && (
              <div className="bg-gray-800 rounded-xl shadow-lg overflow-hidden">
                <button
                  onClick={() => setIsLogsOpen(!isLogsOpen)}
                  className="w-full p-3 sm:p-4 flex items-center justify-between text-left hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className={`h-4 w-4 sm:h-5 sm:w-5 transform transition-transform ${isLogsOpen ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-semibold text-gray-200 text-sm sm:text-base">{t.processLogs}</span>
                  </div>
                </button>

                {isLogsOpen && (
                  <div className="border-t border-gray-700 max-h-40 sm:max-h-60 overflow-y-auto p-3 sm:p-4">
                    <pre className="text-xs sm:text-sm text-gray-400 whitespace-pre-wrap">
                      {logs.join('\n')}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Add PerformanceMetrics before Progress Bar */}
            {processing && <PerformanceMetrics />}

            {/* Add ProcessingSummary after Logs Section */}
            {!processing && systemMetrics.processedSize > 0 && <ProcessingSummary />}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-8 border-t border-gray-700/30">
          <div className="text-center text-sm text-gray-400">
            <p className="flex items-center justify-center gap-2">
              Built by{' '}
              <a
                href="https://mkdir.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
              >
                Muzaffer Kadir YILMAZ
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </p>
            <p className="mt-2">
              <a
                href="https://github.com/muzafferkadir"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-300 transition-colors"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                @muzafferkadir
              </a>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
