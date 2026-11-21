package studio.ai.ultronexe;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class UltronVoiceForegroundService extends Service {
    public static final String CHANNEL_ID = "ultron_voice_assistant_channel";
    public static final int NOTIFICATION_ID = 7401;

    public static final String ACTION_START = "studio.ai.ultronexe.ACTION_START_VOICE_SERVICE";
    public static final String ACTION_UPDATE_CONFIG = "studio.ai.ultronexe.ACTION_UPDATE_VOICE_CONFIG";
    public static final String ACTION_STOP = "studio.ai.ultronexe.ACTION_STOP_VOICE_SERVICE";
    public static final String ACTION_PAUSE_FOR_PTT = "studio.ai.ultronexe.ACTION_PAUSE_FOR_PTT";
    public static final String ACTION_RESUME_AFTER_PTT = "studio.ai.ultronexe.ACTION_RESUME_AFTER_PTT";
    public static final String ACTION_SET_SPEAKING = "studio.ai.ultronexe.ACTION_SET_SPEAKING_STATE";
    public static final String ACTION_VOICE_EVENT = "studio.ai.ultronexe.ACTION_VOICE_EVENT";

    public static volatile boolean isServiceRunning = false;
    public static volatile String currentServiceStatus = "idle";
    public static volatile String currentWakePhrase = "Hey Ultron";
    public static volatile boolean wakeWordActive = true;
    public static volatile boolean isPausedForPtt = false;
    public static volatile boolean isTtsSpeaking = false;
    public static volatile boolean isCommandArmed = false;

    private static final long COMMAND_ARM_WINDOW_MS = 10_000L;
    private static final long POST_TTS_ECHO_COOLDOWN_MS = 850L;

    private Handler mainHandler;
    private SpeechRecognizer speechRecognizer;
    private String languageTag = "hi-IN";
    private boolean stopRequested = false;
    private int consecutiveFailures = 0;
    private long commandArmExpiresAtMs = 0L;
    private long speakingCooldownUntilMs = 0L;
    private final Runnable restartRunnable = this::startOnDeviceRecognizerLoop;

    public static void pauseForPtt(Context ctx) {
        isPausedForPtt = true;
        if (!isServiceRunning) return;
        Intent intent = new Intent(ctx, UltronVoiceForegroundService.class);
        intent.setAction(ACTION_PAUSE_FOR_PTT);
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {}
    }

    public static void resumeAfterPtt(Context ctx, long delayMs) {
        isPausedForPtt = false;
        if (!isServiceRunning) return;
        Intent intent = new Intent(ctx, UltronVoiceForegroundService.class);
        intent.setAction(ACTION_RESUME_AFTER_PTT);
        intent.putExtra("delayMs", delayMs);
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {}
    }

    public static void setSpeakingState(Context ctx, boolean speaking) {
        isTtsSpeaking = speaking;
        if (!isServiceRunning) return;
        Intent intent = new Intent(ctx, UltronVoiceForegroundService.class);
        intent.setAction(ACTION_SET_SPEAKING);
        intent.putExtra("speaking", speaking);
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {}
    }

    public static void stopFromApp(Context ctx) {
        isCommandArmed = false;
        isPausedForPtt = false;
        isTtsSpeaking = false;
        if (!isServiceRunning) {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.cancel(NOTIFICATION_ID);
            }
            return;
        }
        Intent intent = new Intent(ctx, UltronVoiceForegroundService.class);
        intent.setAction(ACTION_STOP);
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {
            try {
                ctx.stopService(new Intent(ctx, UltronVoiceForegroundService.class));
            } catch (Exception ignored2) {}
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopAssistantCleanly("idle", "Background voice assistant stopped.");
            return START_NOT_STICKY;
        }

        if (ACTION_PAUSE_FOR_PTT.equals(action)) {
            isPausedForPtt = true;
            isCommandArmed = false;
            mainHandler.removeCallbacks(restartRunnable);
            destroyRecognizer();
            if (isServiceRunning) {
                currentServiceStatus = "listening";
                updateNotification("Push-to-Talk active — background wake word paused");
            }
            return START_STICKY;
        }

        if (ACTION_RESUME_AFTER_PTT.equals(action)) {
            isPausedForPtt = false;
            long delayMs = intent != null ? intent.getLongExtra("delayMs", 550L) : 550L;
            if (isServiceRunning && !stopRequested && !isTtsSpeaking) {
                mainHandler.removeCallbacks(restartRunnable);
                updateNotification(buildIdleListeningNotice());
                mainHandler.postDelayed(restartRunnable, Math.max(250L, delayMs));
            }
            return START_STICKY;
        }

        if (ACTION_SET_SPEAKING.equals(action)) {
            boolean speaking = intent != null && intent.getBooleanExtra("speaking", false);
            isTtsSpeaking = speaking;
            mainHandler.removeCallbacks(restartRunnable);
            if (speaking) {
                destroyRecognizer();
                if (isServiceRunning) {
                    currentServiceStatus = "speaking";
                    updateNotification("Ultron is speaking — wake word paused");
                }
            } else {
                speakingCooldownUntilMs = System.currentTimeMillis() + POST_TTS_ECHO_COOLDOWN_MS;
                if (isServiceRunning && !stopRequested && !isPausedForPtt) {
                    updateNotification(buildIdleListeningNotice());
                    mainHandler.postDelayed(restartRunnable, POST_TTS_ECHO_COOLDOWN_MS);
                }
            }
            return START_STICKY;
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            stopAssistantCleanly("permission_denied", "Microphone permission is required for background assistant.");
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String wake = intent.getStringExtra("wakeWord");
            if (wake != null && !wake.trim().isEmpty()) {
                currentWakePhrase = wake.trim();
            }
            String lang = intent.getStringExtra("lang");
            if (lang != null && !lang.trim().isEmpty()) {
                languageTag = lang.trim();
            }
            if (intent.hasExtra("wakeWordEnabled")) {
                wakeWordActive = intent.getBooleanExtra("wakeWordEnabled", true);
            }
        }

        if (ACTION_UPDATE_CONFIG.equals(action) && isServiceRunning) {
            updateNotification(buildIdleListeningNotice());
            emitEvent("status", currentServiceStatus, "");
            if (!isPausedForPtt && !isTtsSpeaking) {
                mainHandler.removeCallbacks(restartRunnable);
                mainHandler.postDelayed(restartRunnable, 200L);
            }
            return START_STICKY;
        }

        stopRequested = false;
        consecutiveFailures = 0;
        isCommandArmed = false;
        commandArmExpiresAtMs = 0L;
        isServiceRunning = true;
        currentServiceStatus = wakeWordActive ? "wake_listening" : "listening";

        Notification notification = buildNotification(buildIdleListeningNotice());

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception ex) {
            isServiceRunning = false;
            currentServiceStatus = "os_restricted";
            emitEvent("error", "os_restricted", "Android OS prevented starting microphone foreground service: " + ex.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }

        mainHandler.removeCallbacks(restartRunnable);
        if (!isPausedForPtt && !isTtsSpeaking) {
            mainHandler.post(restartRunnable);
        }
        return START_STICKY;
    }

    private String buildIdleListeningNotice() {
        if (isCommandArmed && System.currentTimeMillis() < commandArmExpiresAtMs) {
            return "Wake word detected — speak your command now";
        }
        return wakeWordActive
            ? "Listening for \"" + currentWakePhrase + "\" — tap Stop anytime"
            : "Voice assistant foreground service active — tap Stop anytime";
    }

    private SpeechRecognizer createBestOnDeviceRecognizer() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            try {
                return SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            } catch (Exception ignored) {
                // Fall back to standard platform recognizer with offline preference
            }
        }
        return SpeechRecognizer.createSpeechRecognizer(this);
    }

    private void startOnDeviceRecognizerLoop() {
        if (stopRequested || !isServiceRunning || isPausedForPtt || isTtsSpeaking) return;

        long now = System.currentTimeMillis();
        if (now < speakingCooldownUntilMs) {
            mainHandler.removeCallbacks(restartRunnable);
            mainHandler.postDelayed(restartRunnable, (speakingCooldownUntilMs - now) + 50L);
            return;
        }

        if (isCommandArmed && now >= commandArmExpiresAtMs) {
            isCommandArmed = false;
            commandArmExpiresAtMs = 0L;
            currentServiceStatus = wakeWordActive ? "wake_listening" : "listening";
            updateNotification(buildIdleListeningNotice());
            emitEvent("status", currentServiceStatus, "");
        }

        boolean canRecognize =
            SpeechRecognizer.isRecognitionAvailable(this) ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(this));

        if (!canRecognize) {
            currentServiceStatus = "recognizer_unavailable";
            updateNotification("On-device speech recognizer unavailable. Use Push-to-Talk in Ultron.");
            emitEvent("status", "recognizer_unavailable", "On-device SpeechRecognizer unavailable on this device. Use Push-to-Talk fallback.");
            return;
        }

        try {
            destroyRecognizer();
            speechRecognizer = createBestOnDeviceRecognizer();
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                    if (stopRequested || !isServiceRunning || isPausedForPtt || isTtsSpeaking) return;
                    if (isCommandArmed && System.currentTimeMillis() < commandArmExpiresAtMs) {
                        currentServiceStatus = "wake_armed";
                    } else {
                        currentServiceStatus = wakeWordActive ? "wake_listening" : "listening";
                    }
                    emitEvent("status", currentServiceStatus, "");
                }

                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}

                @Override
                public void onError(int error) {
                    if (stopRequested || !isServiceRunning) return;
                    if (isPausedForPtt || isTtsSpeaking) return;

                    if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                        stopAssistantCleanly("permission_denied", "Microphone permission revoked.");
                        return;
                    }

                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        consecutiveFailures = 0;
                        mainHandler.removeCallbacks(restartRunnable);
                        mainHandler.postDelayed(restartRunnable, 350L);
                        return;
                    }

                    consecutiveFailures++;
                    if (consecutiveFailures >= 4) {
                        currentServiceStatus = "paused_os_limit";
                        updateNotification("Continuous speech paused by Android. Tap to use Push-to-Talk.");
                        emitEvent(
                            "status",
                            "paused_os_limit",
                            "Continuous speech recognition paused by Android (" + error + "). Push-to-Talk remains available."
                        );
                        return;
                    }
                    mainHandler.removeCallbacks(restartRunnable);
                    mainHandler.postDelayed(restartRunnable, 1200L * consecutiveFailures);
                }

                @Override
                public void onResults(Bundle results) {
                    if (stopRequested || !isServiceRunning) return;
                    if (isPausedForPtt || isTtsSpeaking || System.currentTimeMillis() < speakingCooldownUntilMs) {
                        return;
                    }
                    consecutiveFailures = 0;

                    ArrayList<String> matches = results != null
                        ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        : null;
                    String transcript = (matches != null && !matches.isEmpty() && matches.get(0) != null)
                        ? matches.get(0).trim()
                        : "";

                    if (!transcript.isEmpty()) {
                        handleCapturedUtterance(transcript);
                    }

                    if (!stopRequested && isServiceRunning && !isPausedForPtt && !isTtsSpeaking) {
                        mainHandler.removeCallbacks(restartRunnable);
                        mainHandler.postDelayed(restartRunnable, 400L);
                    }
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    // Only observe status; commit cleanly inside onResults to avoid splitting "Hey Ultron, <command>"
                }

                @Override public void onEvent(int eventType, Bundle params) {}
            });

            Intent recIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag);
            recIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            recIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            recIntent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);

            speechRecognizer.startListening(recIntent);
        } catch (Exception ex) {
            currentServiceStatus = "paused_os_limit";
            updateNotification("Speech service unavailable in background. Tap to use Push-to-Talk.");
            emitEvent("error", "paused_os_limit", "Could not start SpeechRecognizer: " + ex.getMessage());
        }
    }

    private void handleCapturedUtterance(String transcript) {
        if (!wakeWordActive) {
            isCommandArmed = false;
            emitEvent("transcript", "listening", transcript, false);
            return;
        }

        WakeMatch wake = extractWakePhrase(transcript, currentWakePhrase);
        if (wake.detected) {
            if (wake.remainder.isEmpty()) {
                // Two-stage wake activation: "Hey Ultron" -> arm command capture window
                isCommandArmed = true;
                commandArmExpiresAtMs = System.currentTimeMillis() + COMMAND_ARM_WINDOW_MS;
                currentServiceStatus = "wake_armed";
                updateNotification("Wake word detected — speak your command now");
                emitEvent("wake_detected", "wake_armed", transcript, true);
            } else {
                // Single-utterance wake + command: "Hey Ultron, torch on karo"
                isCommandArmed = false;
                commandArmExpiresAtMs = 0L;
                currentServiceStatus = "wake_listening";
                updateNotification(buildIdleListeningNotice());
                emitEvent("transcript", "wake_listening", transcript, true);
            }
            return;
        }

        // User already activated with "Hey Ultron" and spoke follow-up command inside window
        if (isCommandArmed && System.currentTimeMillis() < commandArmExpiresAtMs) {
            isCommandArmed = false;
            commandArmExpiresAtMs = 0L;
            currentServiceStatus = "wake_listening";
            updateNotification(buildIdleListeningNotice());
            emitEvent("transcript", "wake_armed", transcript, true);
        }
    }

    private static class WakeMatch {
        final boolean detected;
        final String remainder;
        WakeMatch(boolean detected, String remainder) {
            this.detected = detected;
            this.remainder = remainder;
        }
    }

    private WakeMatch extractWakePhrase(String raw, String wakePhrase) {
        String trimmed = raw == null ? "" : raw.trim();
        if (trimmed.isEmpty()) return new WakeMatch(false, "");

        String phrase = (wakePhrase == null || wakePhrase.trim().isEmpty()) ? "Hey Ultron" : wakePhrase.trim();
        String escaped = Pattern.quote(phrase).replaceAll("\\s+", "\\\\E\\\\s+\\\\Q");
        Pattern customPattern = Pattern.compile("^(?:" + escaped + ")[,:\\s\\-!?]*", Pattern.CASE_INSENSITIVE);
        Matcher customMatcher = customPattern.matcher(trimmed);
        if (customMatcher.find()) {
            return new WakeMatch(true, trimmed.substring(customMatcher.end()).trim());
        }

        if (phrase.toLowerCase(Locale.US).contains("ultron")) {
            Pattern fallbackPattern = Pattern.compile(
                "^(?:hey|hi|hello|ok|okay|yo|listen|suno|a|hay|हे)?\\s*(?:ultron|altron|ultran|electron|अल्ट्रॉन|अल्ट्रोन|उल्ट्रोन)[,:\\s\\-!?]*",
                Pattern.CASE_INSENSITIVE
            );
            Matcher m = fallbackPattern.matcher(trimmed);
            if (m.find()) {
                return new WakeMatch(true, trimmed.substring(m.end()).trim());
            }
        }
        return new WakeMatch(false, trimmed);
    }

    private void stopAssistantCleanly(String status, String message) {
        stopRequested = true;
        isServiceRunning = false;
        isPausedForPtt = false;
        isTtsSpeaking = false;
        isCommandArmed = false;
        commandArmExpiresAtMs = 0L;
        currentServiceStatus = status;
        if (mainHandler != null) {
            mainHandler.removeCallbacksAndMessages(null);
        }
        destroyRecognizer();
        emitEvent("stopped", status, message, false);
        cancelServiceNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    private void cancelServiceNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(NOTIFICATION_ID);
        }
    }

    private void destroyRecognizer() {
        if (speechRecognizer != null) {
            try {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
            } catch (Exception ignored) {}
            speechRecognizer = null;
        }
    }

    private void emitEvent(String type, String status, String text) {
        emitEvent(type, status, text, isCommandArmed);
    }

    private void emitEvent(String type, String status, String text, boolean wakeDetected) {
        Intent broadcast = new Intent(ACTION_VOICE_EVENT);
        broadcast.setPackage(getPackageName());
        broadcast.putExtra("type", type);
        broadcast.putExtra("status", status);
        broadcast.putExtra("text", text);
        broadcast.putExtra("running", isServiceRunning);
        broadcast.putExtra("commandArmed", isCommandArmed);
        broadcast.putExtra("wakeDetected", wakeDetected);
        sendBroadcast(broadcast);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Ultron Voice Assistant",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Visible privacy indicator while Ultron Voice Assistant microphone service is active.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void updateNotification(String contentText) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && isServiceRunning) {
            manager.notify(NOTIFICATION_ID, buildNotification(contentText));
        }
    }

    private Notification buildNotification(String contentText) {
        Intent openAppIntent = new Intent(this, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, UltronVoiceForegroundService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Ultron AI — Voice Assistant")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openPendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop Listening", stopPendingIntent)
            .build();
    }

    @Override
    public void onDestroy() {
        stopRequested = true;
        isServiceRunning = false;
        isPausedForPtt = false;
        isTtsSpeaking = false;
        isCommandArmed = false;
        currentServiceStatus = "idle";
        if (mainHandler != null) {
            mainHandler.removeCallbacksAndMessages(null);
        }
        destroyRecognizer();
        cancelServiceNotification();
        emitEvent("stopped", "idle", "Background voice service stopped.", false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
