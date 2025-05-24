/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import { marked } from 'marked';

const MODEL_NAME = 'gemini-2.5-flash-preview-04-17';

const TAVILY_API_KEY = "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"; 

interface Note {
  id: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number;
}

interface TavilyWebResult {
  title: string;
  url: string;
  content: string;
}

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;
  private conversationHistory: string[] = [];

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  private isProcessingAction = false; // Flag to prevent concurrent major actions
  private currentWebSearchResults: TavilyWebResult[] | null = null;


  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY!,
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.initTheme();
    this.createNewNote();

    this.recordingStatus.textContent = 'Ready to record';
  }

  private logToDebugPanel(message: string): void {
    const debugPanel = document.getElementById('micStatus');
    if (debugPanel) {
      if (!debugPanel.classList.contains('visible')) {
          // Make it visible on first log, or if you prefer, toggle manually in dev tools.
          // debugPanel.classList.add('visible');
      }
      // Fix: Replaced toLocaleTimeString with manual formatting to include milliseconds
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
      const time = `${hours}:${minutes}:${seconds}.${milliseconds}`;
      const p = document.createElement('p');
      p.textContent = `${time}: ${message}`;
      debugPanel.appendChild(p);
      debugPanel.scrollTop = debugPanel.scrollHeight; // Auto-scroll to see the latest message

      console.log(`DEBUG: ${message}`); // Also log to console for easier access during dev.
    } else {
      console.log(`DEBUG (no panel): ${message}`); // Fallback to console if panel not found
    }
  }


  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  public initSpeechRecognition(): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Speech recognition is not supported in this browser.');
      this.recordingStatus.textContent = '语音识别在此浏览器中不受支持。';
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN'; // Set to Chinese
    recognition.interimResults = false; 
    recognition.maxAlternatives = 1;

    let silenceActivityTimer: NodeJS.Timeout | undefined = undefined;

    const clearSilenceActivityTimer = () => {
        if (silenceActivityTimer) {
            clearTimeout(silenceActivityTimer);
            silenceActivityTimer = undefined;
        }
    };

    const startOrResetSilenceActivityTimer = () => {
      clearSilenceActivityTimer();
      if (this.isRecording) { 
        silenceActivityTimer = setTimeout(() => {
          this.logToDebugPanel('自动停止录音 (15s 无语音)');
          this.logToDebugPanel(`Timer callback state: isRecording=${this.isRecording}, mediaRecorder=${!!this.mediaRecorder}, mediaRecorder.state=${this.mediaRecorder?.state}`);
          if (this.isRecording) {
             this.stopRecording().catch(e => console.error("Error stopping recording from silence timer:", e));
          } else {
             this.logToDebugPanel("Timer fired, but isRecording is false. Not calling stopRecording.");
          }
        }, 15000); // Increased to 15 seconds
      }
    };

    recognition.onstart = () => {
      this.recordingStatus.textContent = '语音识别已启动，等待指令...';
      this.logToDebugPanel('Speech recognition started.');
      if (this.isRecording) {
        startOrResetSilenceActivityTimer();
      }
    };

    recognition.onresult = async (event: any) => { 
      const rawResult = event.results[0][0].transcript;
      this.logToDebugPanel(`Raw speech: "${rawResult}"`);
      const result = rawResult.trim();
      this.logToDebugPanel(`Trimmed speech: "${result}", isProcessing: ${this.isProcessingAction}`);

      // Sanitize common punctuation that might interfere with command matching
      const commandRecognized = result.toLowerCase().replace(/[，。！？?,!]/g, '').trim();
      this.logToDebugPanel(`Sanitized command: "${commandRecognized}"`);


      const webSearchTriggers = ["搜索", "查询", "查找", "帮我找"];
      let foundWebSearchTrigger = "";
      let webSearchQuery = "";

      for (const trigger of webSearchTriggers) {
        this.logToDebugPanel(`Checking trigger: "${trigger}" against "${commandRecognized}"`);
        // commandRecognized.startsWith(trigger + " ") handles "trigger query"
        // commandRecognized === trigger handles "trigger" (no query part)
        if (commandRecognized.startsWith(trigger + " ") || commandRecognized === trigger) {
            foundWebSearchTrigger = trigger;
            webSearchQuery = commandRecognized.substring(trigger.length).trim();
            this.logToDebugPanel(`MATCHED trigger: "${trigger}", query: "${webSearchQuery}"`);
            break;
        }
      }

      if (foundWebSearchTrigger) {
        this.logToDebugPanel(`Web search trigger found: "${foundWebSearchTrigger}", query: "${webSearchQuery}"`);
        if (webSearchQuery) {
            if (!this.isProcessingAction) {
                this.isProcessingAction = true; // Set busy flag
                this.logToDebugPanel(`Calling performWebSearchAndRepolish for query: "${webSearchQuery}"`);
                this.performWebSearchAndRepolish(webSearchQuery)
                    .catch(e => {
                        console.error("Error during web search and repolish:", e);
                        this.logToDebugPanel(`Error during web search/repolish: ${e}`);
                        this.recordingStatus.textContent = "网络搜索或处理时出错。";
                        // isProcessingAction is reset in performWebSearchAndRepolish's finally
                    });
            } else {
                this.logToDebugPanel(`Skipping web search: isProcessingAction is true.`);
                this.recordingStatus.textContent = "正在处理上一指令，请稍候。";
            }
        } else {
            this.logToDebugPanel(`Web search trigger found, but no query. Prompting for keywords.`);
            this.recordingStatus.textContent = `请提供搜索关键词。例如：“${foundWebSearchTrigger} 关于最新的AI技术”`;
        }
        // Only reset silence timer if a web search command with a query was found
        if (foundWebSearchTrigger && webSearchQuery && this.isRecording) {
             this.logToDebugPanel(`Web search command with query "${webSearchQuery}" received. Resetting silence timer.`);
             startOrResetSilenceActivityTimer();
        }
        return; // Command processed
      } else {
         this.logToDebugPanel(`No web search trigger matched for command: "${commandRecognized}"`);
      }


      if (result === '好的' || result === '开始') {
        this.logToDebugPanel(`Command '开始'/'好的' received. isRecording: ${this.isRecording}, isProcessingAction: ${this.isProcessingAction}`);
        if (!this.isRecording && !this.isProcessingAction) {
            this.isProcessingAction = true;
            await this.startRecording().finally(() => { this.isProcessingAction = false; });
            // Reset timer only after successfully starting recording
            if (this.isRecording) {
                this.logToDebugPanel("Recording started. Resetting silence timer.");
                startOrResetSilenceActivityTimer(); 
            }
        } else if (this.isRecording) {
            this.logToDebugPanel("Command '开始' ignored, already recording. Resetting silence timer.");
            startOrResetSilenceActivityTimer(); // Reset silence timer if '开始' is repeated during recording
        } else {
             this.recordingStatus.textContent = "正在处理上一指令，请稍候。";
             this.logToDebugPanel("Command '开始' ignored, isProcessingAction is true.");
        }
      } else if (result === 'OK' || result === '结束') {
        this.logToDebugPanel(`Command '结束'/'OK' received. isRecording: ${this.isRecording}, isProcessingAction: ${this.isProcessingAction}`);
        if (this.isRecording && !this.isProcessingAction) {
            this.isProcessingAction = true;
            await this.stopRecording().finally(() => { this.isProcessingAction = false; });
            clearSilenceActivityTimer(); // Clear timer after stopping recording
        } else if (!this.isRecording) {
            this.logToDebugPanel("Command '结束' ignored, not recording.");
        } else {
            this.recordingStatus.textContent = "正在处理上一指令，请稍候。";
            this.logToDebugPanel("Command '结束' ignored, isProcessingAction is true.");
        }
      } else {
        this.logToDebugPanel(`Unrecognized command or speech during recording: "${result}"`);
        // Only reset silence timer if a non-empty, non-command result is received during recording
        if (this.isRecording && result.trim() !== '') {
          this.logToDebugPanel(`Non-empty, non-command speech result "${result.trim()}" received. Resetting silence timer.`);
          startOrResetSilenceActivityTimer(); 
        } else if (this.isRecording) {
           this.logToDebugPanel(`Empty, whitespace, or command speech result received "${result}". Silence timer NOT reset.`);
        }
      }
    };

    recognition.onerror = (event: any) => {
      this.logToDebugPanel(`Speech recognition error: ${event.error}`);
      if (event.error === 'no-speech') {
        console.log('Speech recognition: No speech detected. Listening will be restarted by onend.');
      } else if (event.error === 'aborted') {
        console.log('Speech recognition: Aborted. Listening will be restarted by onend if appropriate.');
      } else {
        console.error('Speech recognition error:', event.error);
        this.recordingStatus.textContent = `语音识别错误: ${event.error}`;
      }
    };

    recognition.onend = () => {
       this.logToDebugPanel(`Speech recognition ended. isRecording: ${this.isRecording}, isProcessingAction: ${this.isProcessingAction}, _stoppedByUserExplicitly: ${(recognition as any)._stoppedByUserExplicitly}`);
      const shouldRestart = !this.isRecording && 
                            !(recognition as any)._stoppedByUserExplicitly && 
                            !this.isProcessingAction;

      if (shouldRestart) {
          this.recordingStatus.textContent = '语音识别已停止，重新启动监听指令...';
          this.logToDebugPanel('Speech recognition trying to restart...');
          try {
            recognition.start();
          } catch (e) {
            console.error("Error restarting speech recognition:", e);
            this.logToDebugPanel(`Error restarting speech recognition: ${e}`);
            this.recordingStatus.textContent = '语音识别无法重启。';
          }
      } else if (this.isRecording && !this.isProcessingAction) {
        this.logToDebugPanel('Speech recognition stopped unexpectedly during recording. Attempting restart...');
        this.recordingStatus.textContent = '语音识别意外停止，但仍在录音中。尝试重启...';
         try {
            recognition.start();
          } catch (e) {
            console.error("Error restarting speech recognition during recording:", e);
            this.logToDebugPanel(`Error restarting speech recognition during recording: ${e}`);
          }
      } else {
         this.logToDebugPanel('Speech recognition stopped and will not restart based on current state.');
         this.recordingStatus.textContent = '语音识别已停止。';
      }
    };
    
    try {
      recognition.start();
    } catch (e) {
        console.error("Error starting speech recognition for the first time:", e);
        this.logToDebugPanel(`Error starting speech recognition for the first time: ${e}`);
        this.recordingStatus.textContent = '语音识别启动失败。';
    }
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private playSound(soundFile: string): void {
    try {
      const audio = new Audio(soundFile); 
      audio.play()
        .catch(e => {
          console.error(`Error playing sound "${soundFile}":`, e);
          this.logToDebugPanel(`Error playing sound ${soundFile}: ${e}`);
        });
    } catch (e) {
      console.error(`Error creating Audio object for "${soundFile}":`, e);
      this.logToDebugPanel(`Error creating Audio for ${soundFile}: ${e}`);
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.isProcessingAction) {
      this.recordingStatus.textContent = "正在处理其他操作，请稍候。";
      this.logToDebugPanel("Toggle recording skipped: isProcessingAction is true.");
      return;
    }
    this.isProcessingAction = true;
    this.logToDebugPanel(`Toggle recording: current state isRecording=${this.isRecording}. Set isProcessingAction=true.`);
    try {
      if (!this.isRecording) {
        await this.startRecording();
      } else {
        await this.stopRecording();
      }
    } finally {
      this.isProcessingAction = false;
      this.logToDebugPanel(`Toggle recording finished. Set isProcessingAction=false.`);
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording // Stop drawing if not recording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5); 

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars)); 
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1; 
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'New Recording';

    this.setupAudioVisualizer(); // Setup after stream is confirmed
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    // Stop drawing waveform
    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    // Release audio resources
    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    try {
      this.logToDebugPanel('Attempting to start recording...');
      this.audioChunks = [];
      // Ensure any previous stream or audio context is fully cleaned up
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }
      
      this.recordingStatus.textContent = 'Requesting microphone access...';
      
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('Failed with basic audio constraints, trying specific fallback:', err);
        this.logToDebugPanel(`getUserMedia basic failed: ${err}. Trying fallback.`);
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { 
                echoCancellation: false, 
                noiseSuppression: false,
                autoGainControl: false,
            }
        });
      }
      this.logToDebugPanel('Microphone access granted.');

      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
       this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.logToDebugPanel(`MediaRecorder.onstop fired. Audio chunks: ${this.audioChunks.length}`);
        this.stopLiveDisplay(); 

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });
          this.logToDebugPanel(`Processing audio blob of size: ${audioBlob.size}, type: ${audioBlob.type}`);
          this.processAudio(audioBlob).catch(err => {
            console.error("Error processing audio:", err);
            this.logToDebugPanel(`Error processing audio: ${err}`);
            this.recordingStatus.textContent = "Error processing recording.";
          });
        } else {
          this.logToDebugPanel("No audio data captured.");
          this.recordingStatus.textContent = "No audio data captured. Please try again.";
        }

        if (this.stream) {
            this.stream.getTracks().forEach(track => {
                track.stop();
            });
            this.stream = null;
            this.logToDebugPanel("Stream tracks stopped in onstop.");
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true; 
      this.logToDebugPanel('MediaRecorder started. isRecording = true.');
      
      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Recording');
      
      this.startLiveDisplay(); 
      this.playSound('pop_up.wav');
      this.recordingStatus.textContent = 'Recording... Speak now.'; 


    } catch (error) {
      console.error('Error starting recording:', error);
      this.logToDebugPanel(`Error starting recording: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "Unknown";

      if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
        this.recordingStatus.textContent = 'Microphone permission denied. Please check browser settings and reload page.';
      } else if (errorName === "NotFoundError" || (errorName === "DOMException" && errorMessage.includes("Requested device not found"))) {
        this.recordingStatus.textContent = 'No microphone found. Please connect a microphone.';
      } else if (errorName === "NotReadableError" || errorName === "AbortError" || (errorName === "DOMException" && errorMessage.includes("Failed to allocate audiosource"))) {
        this.recordingStatus.textContent = 'Cannot access microphone. It may be in use by another application.';
      } else {
        this.recordingStatus.textContent = `Error: ${errorMessage}`;
      }
      
      this.isRecording = false; 
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.stopLiveDisplay(); 
    }
  }

  private async stopRecording(): Promise<void> {
    this.logToDebugPanel(`Attempting to stop recording. MediaRecorder state: ${this.mediaRecorder?.state}, isRecording: ${this.isRecording}`);
    if (this.mediaRecorder && this.isRecording) {
      this.isRecording = false; 
      
      try {
        this.mediaRecorder.stop(); 
        this.logToDebugPanel('MediaRecorder.stop() called.');
      } catch (e) {
        console.error('Error explicitly stopping MediaRecorder:', e);
        this.logToDebugPanel(`Error calling MediaRecorder.stop(): ${e}`);
        this.recordButton.classList.remove('recording');
        this.recordButton.setAttribute('title', 'Start Recording');
        this.stopLiveDisplay();
        this.recordingStatus.textContent = 'Error stopping. Ready to try again.';
        return;
      }

      this.playSound('pop_up.wav');
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.recordingStatus.textContent = 'Processing audio...'; 
    } else {
      this.logToDebugPanel('Stop recording called but not actually recording or no mediaRecorder.');
      this.isRecording = false;
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.stopLiveDisplay();
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent =
        'No audio data captured. Please try again.';
      this.logToDebugPanel("processAudio: No data in audioBlob.");
      return;
    }

    try {
      URL.createObjectURL(audioBlob); 

      this.recordingStatus.textContent = 'Converting audio...';
      this.logToDebugPanel("processAudio: Converting audio...");

      const reader = new FileReader();
      const readResult = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            const base64data = reader.result as string;
            const base64Audio = base64data.split(',')[1];
            resolve(base64Audio);
          } catch (err) {
            reject(new Error('Failed to process base64 data from FileReader.'));
          }
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader error.'));
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await readResult;

      if (!base64Audio) throw new Error('Failed to convert audio to base64');
      this.logToDebugPanel("processAudio: Audio converted to base64.");

      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      console.error('Error in processAudio:', error);
      this.logToDebugPanel(`Error in processAudio: ${error}`);
      this.recordingStatus.textContent =
        'Error processing recording. Please try again.';
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    try {
      this.recordingStatus.textContent = 'Getting transcription...';
      this.logToDebugPanel("Getting transcription...");

      const contents = [
        { text: 'Generate a complete, detailed transcript of this audio.' },
        { inlineData: { mimeType: mimeType, data: base64Audio } },
      ];

      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });

      const transcriptionText = response.text as string;
      this.logToDebugPanel(`Transcription received: "${transcriptionText ? transcriptionText.substring(0,100) + '...' : 'EMPTY'}"`);


      if (transcriptionText) {
        this.conversationHistory.push(transcriptionText);
        if (this.conversationHistory.length > 10) {
          this.conversationHistory.shift();
        }

        const updateTranscription = () => {
          this.rawTranscription.textContent = transcriptionText;
          if (transcriptionText.trim() !== '') {
            this.rawTranscription.classList.remove('placeholder-active');
          } else {
            const placeholder =
              this.rawTranscription.getAttribute('placeholder') || '';
            this.rawTranscription.textContent = placeholder;
            this.rawTranscription.classList.add('placeholder-active');
          }

          if (this.currentNote)
            this.currentNote.rawTranscription = transcriptionText;
          this.recordingStatus.textContent =
            'Transcription complete. Polishing note...';
          this.logToDebugPanel("Transcription complete. Polishing note...");
          this.getPolishedNote().catch((err) => {
            console.error('Error polishing note:', err);
            this.logToDebugPanel(`Error polishing note after transcription: ${err}`);
            this.recordingStatus.textContent =
              'Error polishing note after transcription.';
          });
        };

        setTimeout(updateTranscription, 0);
      } else {
        this.recordingStatus.textContent =
          'Transcription failed or returned empty.';
        this.logToDebugPanel("Transcription failed or returned empty.");
        this.polishedNote.innerHTML =
          '<p><em>Could not transcribe audio. Please try again.</em></p>';
        this.rawTranscription.textContent =
          this.rawTranscription.getAttribute('placeholder');
        this.rawTranscription.classList.add('placeholder-active');
      }
    } catch (error) {
      console.error('Error getting transcription:', error);
      this.logToDebugPanel(`Error getting transcription: ${error}`);
      this.recordingStatus.textContent =
        'Error getting transcription. Please try again.';
      this.polishedNote.innerHTML = `<p><em>Error during transcription: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.rawTranscription.textContent =
        this.rawTranscription.getAttribute('placeholder');
      this.rawTranscription.classList.add('placeholder-active');
    }
  }
  
  private async searchTavilyImagesDirectly(query: string): Promise<string[]> {
    this.logToDebugPanel(`Searching Tavily images for: "${query}"`);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: `${query} high quality no watermark`,
          search_depth: 'advanced',
          include_images: true,
          max_results: 5,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error(`Tavily API error (images): ${response.status} ${response.statusText}`, errorData);
        this.logToDebugPanel(`Tavily API error (images) ${response.status}: ${errorData}`);
        return [];
      }

      const data = await response.json();
      if (data && data.images && data.images.length > 0) {
        this.logToDebugPanel(`Tavily image search found ${data.images.length} images.`);
        return data.images;
      } else {
        console.warn('Tavily image search successful but no images found for query:', query, data);
        this.logToDebugPanel(`Tavily image search: no images found for "${query}". Response: ${JSON.stringify(data)}`);
        return [];
      }
    } catch (error) {
      console.error('Failed to fetch from Tavily API (images):', error);
      this.logToDebugPanel(`Failed to fetch Tavily images: ${error}`);
      return [];
    }
  }

  private async searchTavilyWeb(query: string): Promise<TavilyWebResult[]> {
    this.logToDebugPanel(`Searching Tavily web for: "${query}"`);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: query,
          search_depth: 'advanced',
          include_answer: false, 
          include_raw_content: false,
          max_results: 3, 
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error(`Tavily API error (web search): ${response.status} ${response.statusText}`, errorData);
        this.logToDebugPanel(`Tavily API error (web) ${response.status}: ${errorData}`);
        return [];
      }

      const data = await response.json();
      if (data && data.results && Array.isArray(data.results)) {
        this.logToDebugPanel(`Tavily web search found ${data.results.length} results.`);
        return data.results.map((item: any) => ({
          title: item.title || 'No Title',
          url: item.url || '',
          content: item.content || '' 
        }));
      } else {
        console.warn('Tavily web search successful but no results array found for query:', query, data);
        this.logToDebugPanel(`Tavily web search: no results array for "${query}". Response: ${JSON.stringify(data)}`);
        return [];
      }
    } catch (error) {
      console.error('Failed to fetch from Tavily API (web search):', error);
      this.logToDebugPanel(`Failed to fetch Tavily web results: ${error}`);
      return [];
    }
  }

  private async performWebSearchAndRepolish(query: string): Promise<void> {
    this.logToDebugPanel(`performWebSearchAndRepolish started for query: "${query}". isProcessingAction is true.`);
    this.recordingStatus.textContent = `正在搜索网页：“${query}”...`;
    try {
        const results = await this.searchTavilyWeb(query);
        if (results && results.length > 0) {
            this.currentWebSearchResults = results;
            this.recordingStatus.textContent = '网络搜索完成，正在整理笔记...';
            this.logToDebugPanel(`Web search complete, ${results.length} results found. Repolishing note.`);
        } else {
            this.recordingStatus.textContent = '未能找到相关网络结果。';
            this.logToDebugPanel('Web search yielded no results.');
            this.currentWebSearchResults = null; 
        }
        await this.getPolishedNote();
    } catch (error) {
        console.error('Error performing web search or repolishing:', error);
        this.logToDebugPanel(`Error in performWebSearchAndRepolish: ${error}`);
        this.recordingStatus.textContent = '网络搜索或笔记整理时发生错误。';
    } finally {
        this.currentWebSearchResults = null; 
        this.isProcessingAction = false; 
        this.logToDebugPanel(`performWebSearchAndRepolish finished. isProcessingAction set to false. Web search results cleared.`);
    }
}


  private async getPolishedNote(): Promise<void> {
    try {
      const rawTextContent = this.rawTranscription.textContent;
      const isRawTranscriptionEmpty = !rawTextContent || rawTextContent.trim() === '' || this.rawTranscription.classList.contains('placeholder-active');
      const areWebResultsEmpty = !this.currentWebSearchResults || this.currentWebSearchResults.length === 0;

      this.logToDebugPanel(`getPolishedNote called. Raw empty: ${isRawTranscriptionEmpty}, Web empty: ${areWebResultsEmpty}`);

      if (isRawTranscriptionEmpty && areWebResultsEmpty) {
        this.recordingStatus.textContent = 'No transcription or web search data to polish.';
        this.logToDebugPanel("No data to polish. Setting placeholder for polished note.");
        const polishedPlaceholder = this.polishedNote.getAttribute('placeholder') || '';
        this.polishedNote.innerHTML = polishedPlaceholder;
        this.polishedNote.classList.add('placeholder-active');
        return;
      }

      this.recordingStatus.textContent = 'Polishing note...';
      this.logToDebugPanel("Polishing note...");

      let conversationPrompt = '';
      if (this.conversationHistory.length > 0) {
        const historyToInclude = this.conversationHistory.slice(0, -1); 
        if (historyToInclude.length > 0) {
          conversationPrompt = historyToInclude.map((text, index) => `Previous Round ${index + 1} (Transcription): ${text}`).join('\n\n') + '\n\n';
        }
      }
      
      let webSearchContextPrompt = '';
      if (this.currentWebSearchResults && this.currentWebSearchResults.length > 0) {
        const searchSnippets = this.currentWebSearchResults.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.content.substring(0, 300) + (r.content.length > 300 ? '...' : '')
        }));
        webSearchContextPrompt = `
**Web Search Context (from your voice command):**
${JSON.stringify(searchSnippets, null, 2)}
---
`;
      this.logToDebugPanel(`Web search context prepared: ${JSON.stringify(searchSnippets).substring(0,100)}...`);
      }

      const prompt = `
${webSearchContextPrompt}
**Your Role:** You are my helpful assistant and thought partner.

**Core Objective:**
Based on the \`Current Raw Transcription\` below (if available), any \`Web Search Context\`, and any preceding \`Conversation History\`, help me:
*   Think deeply about my notes and ideas.
*   Discover new perspectives and insights.
*   Collaborate with me to create interesting works.
*   If web search context is provided, synthesize it with the transcription (if any) or use it as the primary basis for your response.

**Interaction Style:**
*   **Question & Guide:** Prioritize helping me uncover *my own* thoughts through insightful questions and guidance. Avoid offering direct conclusions prematurely.
*   **Offer Suggestions (When Explicitly Asked):** If I ask for your suggestion, please provide it.
*   **Collaborative Exploration:** Feel free to share your own relevant thoughts; we will explore them together.
*   **Direct Communication:** Ask questions or provide responses directly, without unnecessary preambles or conversational filler.

**Output Format:**
*   All responses must be in Markdown and Chinese.
*   If you believe an image would significantly enhance the understanding or appeal of this note, include a special placeholder in your response in EXACTLY this format: \`[SEARCH_IMAGE: "a concise search query for the image in English"]\`. For example, if the note is about a recipe for apple pie, you might include \`[SEARCH_IMAGE: "slice of apple pie with ice cream"]\`. Only include this placeholder if an image is truly relevant and adds clear value. Do not invent facts or images if the text doesn't support it. If no image is needed, just provide the polished text.

---
**Input Data:**

${conversationPrompt}
**Current Raw Transcription:**
${isRawTranscriptionEmpty ? '(No transcription provided or transcription is empty)' : rawTextContent}
---`;
      this.logToDebugPanel(`Prompt for Gemini: ${prompt.substring(0, 200)}...`);
      const contents = [{ text: prompt }];

      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });
      let polishedText = response.text as string;
      this.logToDebugPanel(`Gemini response (polishedText): ${polishedText ? polishedText.substring(0,100) + '...' : 'EMPTY'}`);


      if (polishedText && polishedText.trim() !== '') {
        const imageSearchRegex = /\[SEARCH_IMAGE: "([^"]+)"\]/;
        const imageSearchMatch = polishedText.match(imageSearchRegex);
        let imageSearchAttempted = false;

        if (imageSearchMatch && imageSearchMatch[1]) {
          imageSearchAttempted = true;
          const imageQuery = imageSearchMatch[1];
          this.recordingStatus.textContent = `Polishing complete. Searching for image: "${imageQuery}"...`;
          this.logToDebugPanel(`Polished text contains image search: "${imageQuery}". Attempting image search.`);
          
          const imageUrls = await this.searchTavilyImagesDirectly(imageQuery);

          if (imageUrls && imageUrls.length > 0) {
            const altText = imageQuery.length > 60 ? imageQuery.substring(0, 57) + "..." : imageQuery;
            const imageTags = imageUrls.map(url => `\n\n![${altText}](${url})\n\n`).join('');
            polishedText = polishedText.replace(imageSearchRegex, imageTags);
            this.recordingStatus.textContent = `Note polished with ${imageUrls.length} image(s).`;
            this.logToDebugPanel(`Image search successful. ${imageUrls.length} image(s) added.`);
          } else {
            polishedText = polishedText.replace(imageSearchRegex, ''); 
            this.recordingStatus.textContent = 'Note polished. (Image(s) not found or an error occurred during search)';
            this.logToDebugPanel(`Image search for "${imageQuery}" found no images or failed. Placeholder removed.`);
            console.warn(`Tavily search for "${imageQuery}" did not yield any image URLs.`);
          }
        }

        const finalPolishedTextForDisplay = polishedText;
        const updatePolishedNote = () => {
          const htmlContent = marked.parse(finalPolishedTextForDisplay) as string;
          this.polishedNote.innerHTML = htmlContent;

          const images = this.polishedNote.querySelectorAll('img');
          images.forEach(img => {
            img.style.maxWidth = '50vw';
          });

          if (finalPolishedTextForDisplay.trim() !== '') {
            this.polishedNote.classList.remove('placeholder-active');
          } else {
            const placeholder = this.polishedNote.getAttribute('placeholder') || '';
            this.polishedNote.innerHTML = placeholder;
            this.polishedNote.classList.add('placeholder-active');
          }

          let noteTitleSet = false;
          const lines: string[] = finalPolishedTextForDisplay.split('\n').map((l: string) => l.trim());

          for (const line of lines) {
            if (line.startsWith('#')) {
              const title = line.replace(/^#+\s+/, '').trim();
              if (this.editorTitle && title) {
                this.editorTitle.textContent = title;
                this.editorTitle.classList.remove('placeholder-active');
                noteTitleSet = true;
                break;
              }
            }
          }

          if (!noteTitleSet && this.editorTitle) {
            for (const line of lines) {
              if (line.length > 0 && !line.startsWith('![') && !line.startsWith('[SEARCH_IMAGE:')) { 
                let potentialTitle = line.replace(
                  /^[\*_\`#\->\s\[\]\(.\d)]+/,
                  '',
                );
                potentialTitle = potentialTitle.replace(/[\*_\`#]+$/, '');
                potentialTitle = potentialTitle.trim();

                if (potentialTitle.length > 3) {
                  const maxLength = 60;
                  this.editorTitle.textContent =
                    potentialTitle.substring(0, maxLength) +
                    (potentialTitle.length > maxLength ? '...' : '');
                  this.editorTitle.classList.remove('placeholder-active');
                  noteTitleSet = true;
                  break;
                }
              }
            }
          }

          if (!noteTitleSet && this.editorTitle) {
            const currentEditorText = this.editorTitle.textContent?.trim();
            const placeholderText =
              this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
            if (
              currentEditorText === '' ||
              currentEditorText === placeholderText
            ) {
              this.editorTitle.textContent = placeholderText;
              if (!this.editorTitle.classList.contains('placeholder-active')) {
                this.editorTitle.classList.add('placeholder-active');
              }
            }
          }

          if (this.currentNote) this.currentNote.polishedNote = finalPolishedTextForDisplay;
          if (!imageSearchAttempted && this.currentWebSearchResults === null) { 
            this.recordingStatus.textContent = 'Note polished. Ready for next recording.';
            this.logToDebugPanel("Note polished. Status: Ready.");
          } else if (!imageSearchAttempted && this.currentWebSearchResults !== null) {
            this.recordingStatus.textContent = 'Note polished after web search.';
            this.logToDebugPanel("Note polished after web search (but currentWebSearchResults was not null, this might be odd). Status: Ready.");
          } else if (imageSearchAttempted) {
             // Status already set based on image search outcome
             this.logToDebugPanel("Note polished with image search attempt. Status already set.");
          }
        };
        setTimeout(updatePolishedNote, 0);
      } else { 
        this.recordingStatus.textContent = 'Polishing returned empty or no content from Gemini.';
        this.logToDebugPanel("Polishing returned empty. Setting placeholder.");
        const polishedPlaceholder = this.polishedNote.getAttribute('placeholder') || '';
        this.polishedNote.innerHTML = polishedPlaceholder;
        this.polishedNote.classList.add('placeholder-active');
        if (this.currentNote) this.currentNote.polishedNote = '';
        
        if (this.editorTitle) {
            const editorPlaceholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
            this.editorTitle.textContent = editorPlaceholder;
            this.editorTitle.classList.add('placeholder-active');
        }
      }
    } catch (error) {
      console.error('Error polishing note:', error);
      this.logToDebugPanel(`Error polishing note: ${error}`);
      this.recordingStatus.textContent = 'Error polishing note. Please try again.';
      const polishedPlaceholder = this.polishedNote.getAttribute('placeholder') || '';
      this.polishedNote.innerHTML = `<p><em>Error during polishing: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      if (this.polishedNote.textContent?.trim() === '' || this.polishedNote.innerHTML.includes('<em>Error during polishing')) {
         this.polishedNote.innerHTML = polishedPlaceholder; 
         this.polishedNote.classList.add('placeholder-active');
      }
    }
  }

  private createNewNote(): void {
    this.logToDebugPanel(`Creating new note. isProcessingAction: ${this.isProcessingAction}, isRecording: ${this.isRecording}`);
    if (this.isProcessingAction && !this.isRecording) { 
        this.recordingStatus.textContent = "Processing previous action, please wait to create a new note.";
        this.logToDebugPanel("New note creation skipped: isProcessingAction is true and not recording.");
        return;
    }

    this.currentNote = {
      id: `note_${Date.now()}`,
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
    };

    const rawPlaceholder =
      this.rawTranscription.getAttribute('placeholder') || '';
    this.rawTranscription.textContent = rawPlaceholder;
    this.rawTranscription.classList.add('placeholder-active');

    const polishedPlaceholder =
      this.polishedNote.getAttribute('placeholder') || '';
    this.polishedNote.innerHTML = polishedPlaceholder;
    this.polishedNote.classList.add('placeholder-active');

    if (this.editorTitle) {
      const placeholder =
        this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
      this.editorTitle.textContent = placeholder;
      this.editorTitle.classList.add('placeholder-active');
    }
    
    this.conversationHistory = [];
    this.currentWebSearchResults = null; 

    if (this.isRecording) {
        this.logToDebugPanel("New note: currently recording, stopping recording.");
        this.toggleRecording().catch(e => {
            console.error("Error stopping recording on new note:", e);
            this.logToDebugPanel(`Error stopping recording on new note: ${e}`);
        }).finally(() => {
             this.recordingStatus.textContent = 'New note created. Ready to record.';
             this.logToDebugPanel("Recording stopped for new note. Status: Ready.");
          });
    } else if (this.isProcessingAction) {
        this.logToDebugPanel("New note: isProcessingAction is true (e.g. web search). Aborting for this note.");
        this.recordingStatus.textContent = 'New note created. Previous web search aborted for this note. Ready to record.';
    }
     else {
      this.recordingStatus.textContent = 'New note created. Ready to record.';
      this.logToDebugPanel("New note created. Status: Ready.");
      this.stopLiveDisplay(); 
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new VoiceNotesApp();
  app.initSpeechRecognition(); 

  // Toggle debug panel visibility with Ctrl+Alt+D
  let ctrlPressed = false;
  let altPressed = false;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') ctrlPressed = true;
    if (e.key === 'Alt') altPressed = true;
    if (e.key === 'd' || e.key === 'D') {
        if (ctrlPressed && altPressed) {
            const debugPanel = document.getElementById('micStatus');
            if (debugPanel) {
                debugPanel.classList.toggle('visible');
                app['logToDebugPanel'](`Debug panel visibility toggled ${debugPanel.classList.contains('visible') ? 'ON' : 'OFF'}.`);
            }
        }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') ctrlPressed = false;
    if (e.key === 'Alt') altPressed = false;
  });


  document
    .querySelectorAll<HTMLElement>('[contenteditable][placeholder]')
    .forEach((el: HTMLElement) => {
      const placeholder = el.getAttribute('placeholder')!;

      function updatePlaceholderState() {
        const currentText = (
          el.id === 'polishedNote' ? el.innerText : el.textContent
        )?.trim();

        if (currentText === '' || currentText === placeholder) {
          if (el.id === 'polishedNote' && currentText === '') {
            el.innerHTML = placeholder;
          } else if (currentText === '') {
            el.textContent = placeholder;
          }
          el.classList.add('placeholder-active');
        } else {
          el.classList.remove('placeholder-active');
        }
      }

      updatePlaceholderState(); 

      el.addEventListener('focus', function () {
        const currentText = (
          this.id === 'polishedNote' ? this.innerText : this.textContent
        )?.trim();
        if (currentText === placeholder) {
          if (this.id === 'polishedNote') this.innerHTML = '';
          else this.textContent = '';
          this.classList.remove('placeholder-active');
        }
      });

      el.addEventListener('blur', function () {
        updatePlaceholderState();
      });
    });
});

export { };
