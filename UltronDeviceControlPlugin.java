package studio.ai.ultronexe;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.AlarmClock;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(
    name = "UltronDeviceControl",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class UltronDeviceControlPlugin extends Plugin {
    private static final Set<String> ALLOWLISTED_COMMANDS = new HashSet<>(Arrays.asList(
        "torch_on",
        "torch_off",
        "torch_toggle",
        "volume_up",
        "volume_down",
        "volume_set",
        "volume_mute",
        "volume_unmute",
        "brightness_up",
        "brightness_down",
        "brightness_set",
        "open_wifi_settings",
        "open_bluetooth_settings",
        "open_sound_settings",
        "open_display_settings",
        "open_battery_settings",
        "open_system_settings",
        "get_battery_status",
        "get_current_time",
        "set_alarm",
        "open_alarms",
        "dial_phone",
        "compose_sms",
        "open_security_settings"
    ));

    private static final Set<String> SENSITIVE_COMMANDS = new HashSet<>(Arrays.asList(
        "dial_phone",
        "compose_sms",
        "open_security_settings"
    ));

    private boolean isTorchOn = false;
    private float appWindowBrightness = -1f;
    private SpeechRecognizer singleTurnRecognizer = null;
    private volatile boolean isSingleRecognizerActive = false;
    private TextToSpeech nativeTts = null;
    private boolean ttsReady = false;
    private BroadcastReceiver serviceReceiver = null;
    private Handler mainHandler;

    @Override
    public void load() {
        mainHandler = new Handler(Looper.getMainLooper());
        initNativeTts();
        registerServiceReceiver();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // Release single-turn Push-to-Talk microphone cleanly when app goes to background
        if (isSingleRecognizerActive) {
            mainHandler.post(() -> {
                destroySingleRecognizer();
                if (UltronVoiceForegroundService.isServiceRunning && !UltronVoiceForegroundService.isTtsSpeaking) {
                    UltronVoiceForegroundService.resumeAfterPtt(getContext(), 400L);
                }
                JSObject ev = new JSObject();
                ev.put("type", "ptt_paused_background");
                notifyListeners("ultronVoiceEvent", ev);
            });
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        JSObject ev = new JSObject();
        ev.put("type", "state_sync");
        ev.put("running", UltronVoiceForegroundService.isServiceRunning);
        ev.put("status", UltronVoiceForegroundService.currentServiceStatus);
        ev.put("commandArmed", UltronVoiceForegroundService.isCommandArmed);
        notifyListeners("ultronVoiceEvent", ev);
    }

    @Override
    protected void handleOnDestroy() {
        if (serviceReceiver != null) {
            try {
                getContext().unregisterReceiver(serviceReceiver);
            } catch (Exception ignored) {}
            serviceReceiver = null;
        }
        destroySingleRecognizer();
        if (nativeTts != null) {
            try {
                nativeTts.stop();
                nativeTts.shutdown();
            } catch (Exception ignored) {}
            nativeTts = null;
        }
        UltronVoiceForegroundService.setSpeakingState(getContext(), false);
        super.handleOnDestroy();
    }

    private void initNativeTts() {
        try {
            nativeTts = new TextToSpeech(getContext(), status -> {
                ttsReady = (status == TextToSpeech.SUCCESS);
                if (ttsReady && nativeTts != null) {
                    nativeTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            UltronVoiceForegroundService.setSpeakingState(getContext(), true);
                            JSObject ev = new JSObject();
                            ev.put("type", "tts_start");
                            notifyListeners("ultronVoiceEvent", ev);
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            UltronVoiceForegroundService.setSpeakingState(getContext(), false);
                            JSObject ev = new JSObject();
                            ev.put("type", "tts_end");
                            notifyListeners("ultronVoiceEvent", ev);
                        }

                        @Override
                        public void onError(String utteranceId) {
                            UltronVoiceForegroundService.setSpeakingState(getContext(), false);
                            JSObject ev = new JSObject();
                            ev.put("type", "tts_end");
                            notifyListeners("ultronVoiceEvent", ev);
                        }
                    });
                }
            });
        } catch (Exception ignored) {
            ttsReady = false;
        }
    }

    private void registerServiceReceiver() {
        serviceReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                JSObject ev = new JSObject();
                ev.put("type", intent.getStringExtra("type"));
                ev.put("status", intent.getStringExtra("status"));
                ev.put("text", intent.getStringExtra("text"));
                ev.put("running", intent.getBooleanExtra("running", false));
                ev.put("commandArmed", intent.getBooleanExtra("commandArmed", false));
                ev.put("wakeDetected", intent.getBooleanExtra("wakeDetected", false));
                notifyListeners("ultronVoiceEvent", ev);
            }
        };
        IntentFilter filter = new IntentFilter(UltronVoiceForegroundService.ACTION_VOICE_EVENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(serviceReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(serviceReceiver, filter);
        }
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        Context ctx = getContext();
        boolean hasFlash = ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH);
        boolean onDeviceSpeech = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
        boolean speechAvailable = SpeechRecognizer.isRecognitionAvailable(ctx) || onDeviceSpeech;
        boolean canWriteSettings = Settings.System.canWrite(ctx);

        JSObject ret = new JSObject();
        ret.put("platform", "android");
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("hasFlash", hasFlash);
        ret.put("speechRecognitionAvailable", speechAvailable);
        ret.put("onDeviceSpeechAvailable", onDeviceSpeech);
        ret.put("canWriteSystemSettings", canWriteSettings);
        ret.put("ttsReady", ttsReady);
        ret.put("isTorchOn", isTorchOn);
        call.resolve(ret);
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        JSObject ret = buildPermissionSnapshot();
        call.resolve(ret);
    }

    private JSObject buildPermissionSnapshot() {
        Context ctx = getContext();
        boolean micGranted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        boolean canWrite = Settings.System.canWrite(ctx);

        JSObject ret = new JSObject();
        ret.put("microphone", micGranted ? "granted" : "prompt");
        ret.put("notifications", notifGranted ? "granted" : "prompt");
        ret.put("canWriteSystemSettings", canWrite);
        return ret;
    }

    @PluginMethod
    public void requestAssistantPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAliases(new String[]{ "microphone", "notifications" }, call, "assistantPermissionsCallback");
        } else {
            requestPermissionForAlias("microphone", call, "assistantPermissionsCallback");
        }
    }

    @PermissionCallback
    private void assistantPermissionsCallback(PluginCall call) {
        JSObject ret = buildPermissionSnapshot();
        ret.put("micState", getPermissionState("microphone") == PermissionState.GRANTED ? "granted" : "denied");
        call.resolve(ret);
    }

    @PluginMethod
    public void executeDeviceCommand(PluginCall call) {
        String commandId = call.getString("commandId", "");
        if (commandId == null || !ALLOWLISTED_COMMANDS.contains(commandId)) {
            call.reject("Blocked: Command '" + commandId + "' is not in Ultron's Android allowlist.");
            return;
        }

        boolean userConfirmed = Boolean.TRUE.equals(call.getBoolean("userConfirmed", false));
        if (SENSITIVE_COMMANDS.contains(commandId) && !userConfirmed) {
            call.reject("Confirmation required before executing sensitive action: " + commandId);
            return;
        }

        JSObject params = call.getObject("params", new JSObject());

        try {
            switch (commandId) {
                case "torch_on":
                    handleTorch(call, true);
                    break;
                case "torch_off":
                    handleTorch(call, false);
                    break;
                case "torch_toggle":
                    handleTorch(call, !isTorchOn);
                    break;
                case "volume_up":
                    handleVolumeAdjust(call, AudioManager.ADJUST_RAISE);
                    break;
                case "volume_down":
                    handleVolumeAdjust(call, AudioManager.ADJUST_LOWER);
                    break;
                case "volume_mute":
                    handleVolumeMute(call, true);
                    break;
                case "volume_unmute":
                    handleVolumeMute(call, false);
                    break;
                case "volume_set":
                    handleVolumeSet(call, params.optInt("level", 50));
                    break;
                case "brightness_up":
                    handleBrightnessStep(call, 0.2f);
                    break;
                case "brightness_down":
                    handleBrightnessStep(call, -0.2f);
                    break;
                case "brightness_set":
                    handleBrightnessPercent(call, params.optInt("level", 50));
                    break;
                case "open_wifi_settings":
                    openSettingsIntent(call,
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? Settings.Panel.ACTION_WIFI : Settings.ACTION_WIFI_SETTINGS,
                        Settings.ACTION_WIFI_SETTINGS,
                        "Wi-Fi Settings opened.");
                    break;
                case "open_bluetooth_settings":
                    openSettingsIntent(call, Settings.ACTION_BLUETOOTH_SETTINGS, Settings.ACTION_SETTINGS, "Bluetooth Settings opened.");
                    break;
                case "open_sound_settings":
                    openSettingsIntent(call,
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? Settings.Panel.ACTION_VOLUME : Settings.ACTION_SOUND_SETTINGS,
                        Settings.ACTION_SOUND_SETTINGS,
                        "Sound Settings opened.");
                    break;
                case "open_display_settings":
                    openSettingsIntent(call, Settings.ACTION_DISPLAY_SETTINGS, Settings.ACTION_SETTINGS, "Display Settings opened.");
                    break;
                case "open_battery_settings":
                    openSettingsIntent(call, Intent.ACTION_POWER_USAGE_SUMMARY, Settings.ACTION_BATTERY_SAVER_SETTINGS, "Battery Settings opened.");
                    break;
                case "open_system_settings":
                    openSettingsIntent(call, Settings.ACTION_SETTINGS, Settings.ACTION_SETTINGS, "Device Settings opened.");
                    break;
                case "open_security_settings":
                    openSettingsIntent(call, Settings.ACTION_SECURITY_SETTINGS, Settings.ACTION_SETTINGS, "Security Settings opened.");
                    break;
                case "get_battery_status":
                    handleBatteryStatus(call);
                    break;
                case "get_current_time":
                    handleCurrentTime(call);
                    break;
                case "set_alarm":
                    handleSetAlarm(call, params);
                    break;
                case "open_alarms":
                    openAlarmList(call);
                    break;
                case "dial_phone":
                    handleDialPhone(call, params.optString("phoneNumber", ""));
                    break;
                case "compose_sms":
                    handleComposeSms(call, params.optString("phoneNumber", ""), params.optString("messageBody", ""));
                    break;
                default:
                    call.reject("Unsupported command: " + commandId);
            }
        } catch (Exception ex) {
            call.reject("Native execution error for " + commandId + ": " + ex.getMessage());
        }
    }

    private void handleTorch(PluginCall call, boolean targetState) throws Exception {
        Context ctx = getContext();
        if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) {
            call.reject("This Android device does not have a camera flashlight.");
            return;
        }
        CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        if (cm == null) {
            call.reject("CameraManager unavailable.");
            return;
        }
        String targetCameraId = null;
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics chars = cm.getCameraCharacteristics(id);
            Boolean flashAvailable = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            Integer lensFacing = chars.get(CameraCharacteristics.LENS_FACING);
            if (Boolean.TRUE.equals(flashAvailable) && (lensFacing == null || lensFacing == CameraCharacteristics.LENS_FACING_BACK)) {
                targetCameraId = id;
                break;
            }
        }
        if (targetCameraId == null) {
            call.reject("No controllable rear camera flash found.");
            return;
        }
        cm.setTorchMode(targetCameraId, targetState);
        isTorchOn = targetState;
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("isTorchOn", isTorchOn);
        ret.put("message", targetState ? "Torch turned ON." : "Torch turned OFF.");
        call.resolve(ret);
    }

    private void handleVolumeAdjust(PluginCall call, int direction) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("AudioManager unavailable.");
            return;
        }
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI);
        int current = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int percent = Math.round((current * 100f) / max);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("volumePercent", percent);
        ret.put("message", "Media volume adjusted to " + percent + "%.");
        call.resolve(ret);
    }

    private void handleVolumeMute(PluginCall call, boolean mute) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("AudioManager unavailable.");
            return;
        }
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, mute ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI);
        int current = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int percent = Math.round((current * 100f) / max);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("volumePercent", percent);
        ret.put("message", mute ? "Media volume muted." : "Media volume unmuted.");
        call.resolve(ret);
    }

    private void handleVolumeSet(PluginCall call, int levelPercent) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("AudioManager unavailable.");
            return;
        }
        int clamped = Math.max(0, Math.min(100, levelPercent));
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int targetVol = Math.round((clamped / 100f) * max);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, targetVol, AudioManager.FLAG_SHOW_UI);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("volumePercent", clamped);
        ret.put("message", "Media volume set to " + clamped + "%.");
        call.resolve(ret);
    }

    private void handleBrightnessStep(PluginCall call, float delta) {
        Context ctx = getContext();
        if (Settings.System.canWrite(ctx)) {
            int current = Settings.System.getInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, 128);
            int next = Math.max(20, Math.min(255, Math.round(current + (delta * 255))));
            Settings.System.putInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
            Settings.System.putInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, next);
            int percent = Math.round((next * 100f) / 255f);
            applyWindowBrightness(next / 255f);
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("brightnessPercent", percent);
            ret.put("scope", "system");
            ret.put("message", "System brightness set to " + percent + "%.");
            call.resolve(ret);
            return;
        }

        // Fallback: adjust Ultron window brightness cleanly and open Display Settings if needed
        float base = appWindowBrightness >= 0f ? appWindowBrightness : 0.6f;
        float nextWindow = Math.max(0.15f, Math.min(1.0f, base + delta));
        applyWindowBrightness(nextWindow);
        int percent = Math.round(nextWindow * 100f);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("brightnessPercent", percent);
        ret.put("scope", "app_window");
        ret.put("needsWriteSettings", true);
        ret.put("message", "Adjusted Ultron screen brightness to " + percent + "%. Grant Modify System Settings or use Display Settings for global brightness.");
        call.resolve(ret);
    }

    private void handleBrightnessPercent(PluginCall call, int percent) {
        int clamped = Math.max(10, Math.min(100, percent));
        float fraction = clamped / 100f;
        Context ctx = getContext();
        applyWindowBrightness(fraction);
        if (Settings.System.canWrite(ctx)) {
            Settings.System.putInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
            Settings.System.putInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, Math.round(fraction * 255f));
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("brightnessPercent", clamped);
            ret.put("scope", "system");
            ret.put("message", "System brightness set to " + clamped + "%.");
            call.resolve(ret);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("brightnessPercent", clamped);
        ret.put("scope", "app_window");
        ret.put("needsWriteSettings", true);
        ret.put("message", "App screen brightness set to " + clamped + "%. Grant Modify System Settings for global brightness.");
        call.resolve(ret);
    }

    private void applyWindowBrightness(float level) {
        appWindowBrightness = level;
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
                lp.screenBrightness = level;
                getActivity().getWindow().setAttributes(lp);
            });
        }
    }

    private void openSettingsIntent(PluginCall call, String primaryAction, String fallbackAction, String okMessage) {
        Intent intent = new Intent(primaryAction);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception primaryErr) {
            Intent fallback = new Intent(fallbackAction);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallback);
        }
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", okMessage);
        call.resolve(ret);
    }

    private void handleBatteryStatus(PluginCall call) {
        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = getContext().registerReceiver(null, filter);
        int level = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) : -1;
        int scale = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, 100) : 100;
        int status = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        int percent = (level >= 0 && scale > 0) ? Math.round((level * 100f) / scale) : -1;
        boolean isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;

        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("batteryPercent", percent);
        ret.put("isCharging", isCharging);
        ret.put("message", percent >= 0
            ? ("Battery is at " + percent + "%" + (isCharging ? " (Charging)" : "") + ".")
            : "Battery percentage unavailable.");
        call.resolve(ret);
    }

    private void handleCurrentTime(PluginCall call) {
        Date now = new Date();
        String timeStr = new SimpleDateFormat("h:mm a", Locale.getDefault()).format(now);
        String dateStr = new SimpleDateFormat("EEE, MMM d, yyyy", Locale.getDefault()).format(now);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("time", timeStr);
        ret.put("date", dateStr);
        ret.put("message", "Current time is " + timeStr + " (" + dateStr + ").");
        call.resolve(ret);
    }

    private void handleSetAlarm(PluginCall call, JSObject params) {
        int hour = Math.max(0, Math.min(23, params.optInt("hour", 7)));
        int minute = Math.max(0, Math.min(59, params.optInt("minute", 0)));
        String label = params.optString("label", "Ultron Alarm");
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", String.format(Locale.US, "Opened Clock to set alarm for %02d:%02d.", hour, minute));
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("No Clock app available to set alarm: " + ex.getMessage());
        }
    }

    private void openAlarmList(PluginCall call) {
        try {
            Intent intent = new Intent(AlarmClock.ACTION_SHOW_ALARMS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("message", "Opened Android Clock alarms.");
            call.resolve(ret);
        } catch (Exception ex) {
            JSObject fallbackParams = new JSObject();
            fallbackParams.put("hour", 7);
            fallbackParams.put("minute", 0);
            handleSetAlarm(call, fallbackParams);
        }
    }

    private void handleDialPhone(PluginCall call, String rawPhone) {
        String sanitized = rawPhone == null ? "" : rawPhone.replaceAll("[^0-9+*#]", "");
        Intent intent = new Intent(Intent.ACTION_DIAL);
        if (!sanitized.isEmpty()) {
            intent.setData(Uri.parse("tel:" + sanitized));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", sanitized.isEmpty() ? "Opened Phone Dialer." : ("Opened Dialer with " + sanitized + "."));
        call.resolve(ret);
    }

    private void handleComposeSms(PluginCall call, String rawPhone, String body) {
        String sanitized = rawPhone == null ? "" : rawPhone.replaceAll("[^0-9+]", "");
        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + sanitized));
        if (body != null && !body.isEmpty()) {
            intent.putExtra("sms_body", body);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "Opened Android Messages composer.");
        call.resolve(ret);
    }

    private SpeechRecognizer createBestSingleRecognizer(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) {
            try {
                return SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
            } catch (Exception ignored) {}
        }
        return SpeechRecognizer.createSpeechRecognizer(ctx);
    }

    @PluginMethod
    public void startSingleVoiceRecognition(PluginCall call) {
        Context ctx = getContext();
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission is not granted.");
            return;
        }
        boolean canRecognize =
            SpeechRecognizer.isRecognitionAvailable(ctx) ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx));
        if (!canRecognize) {
            call.reject("On-device SpeechRecognizer is unavailable on this Android build.");
            return;
        }

        // Stop any active Ultron TTS before listening to prevent speaker feedback
        if (nativeTts != null) {
            try {
                nativeTts.stop();
            } catch (Exception ignored) {}
        }
        UltronVoiceForegroundService.setSpeakingState(ctx, false);

        final boolean wasBackgroundRunning = UltronVoiceForegroundService.isServiceRunning;
        if (wasBackgroundRunning) {
            UltronVoiceForegroundService.pauseForPtt(ctx);
        }

        final String lang = call.getString("lang", "hi-IN");
        long handoffDelayMs = wasBackgroundRunning ? 160L : 0L;

        mainHandler.postDelayed(() -> {
            try {
                destroySingleRecognizer();
                isSingleRecognizerActive = true;
                singleTurnRecognizer = createBestSingleRecognizer(ctx);
                singleTurnRecognizer.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle params) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() {}

                    @Override
                    public void onError(int error) {
                        isSingleRecognizerActive = false;
                        JSObject ev = new JSObject();
                        ev.put("type", "single_stt_error");
                        ev.put("errorCode", error);
                        ev.put("text", error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                            ? "No speech detected. Please tap microphone and speak clearly."
                            : "Speech recognition error (" + error + ").");
                        notifyListeners("ultronVoiceEvent", ev);
                        destroySingleRecognizer();
                        if (UltronVoiceForegroundService.isServiceRunning && !UltronVoiceForegroundService.isTtsSpeaking) {
                            UltronVoiceForegroundService.resumeAfterPtt(ctx, 500L);
                        }
                    }

                    @Override
                    public void onResults(Bundle results) {
                        isSingleRecognizerActive = false;
                        ArrayList<String> matches = results != null ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) : null;
                        String transcript = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                        JSObject ev = new JSObject();
                        ev.put("type", "single_stt_result");
                        ev.put("text", transcript);
                        notifyListeners("ultronVoiceEvent", ev);
                        destroySingleRecognizer();
                        if (UltronVoiceForegroundService.isServiceRunning && !UltronVoiceForegroundService.isTtsSpeaking) {
                            UltronVoiceForegroundService.resumeAfterPtt(ctx, 700L);
                        }
                    }

                    @Override public void onPartialResults(Bundle partialResults) {}
                    @Override public void onEvent(int eventType, Bundle params) {}
                });

                Intent recIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                recIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                recIntent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                singleTurnRecognizer.startListening(recIntent);

                JSObject ret = new JSObject();
                ret.put("started", true);
                call.resolve(ret);
            } catch (Exception ex) {
                isSingleRecognizerActive = false;
                if (UltronVoiceForegroundService.isServiceRunning) {
                    UltronVoiceForegroundService.resumeAfterPtt(ctx, 400L);
                }
                call.reject("Failed to start Android SpeechRecognizer: " + ex.getMessage());
            }
        }, handoffDelayMs);
    }

    @PluginMethod
    public void stopSingleVoiceRecognition(PluginCall call) {
        mainHandler.post(() -> {
            destroySingleRecognizer();
            if (UltronVoiceForegroundService.isServiceRunning && !UltronVoiceForegroundService.isTtsSpeaking) {
                UltronVoiceForegroundService.resumeAfterPtt(getContext(), 400L);
            }
        });
        call.resolve();
    }

    private void destroySingleRecognizer() {
        isSingleRecognizerActive = false;
        if (singleTurnRecognizer != null) {
            try {
                singleTurnRecognizer.cancel();
                singleTurnRecognizer.destroy();
            } catch (Exception ignored) {}
            singleTurnRecognizer = null;
        }
    }

    @PluginMethod
    public void speakNative(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "hi-IN");
        float rate = call.getFloat("rate", 1.0f);
        float pitch = call.getFloat("pitch", 0.65f);

        if (text == null || text.trim().isEmpty() || !ttsReady || nativeTts == null) {
            JSObject ret = new JSObject();
            ret.put("spoken", false);
            call.resolve(ret);
            return;
        }

        UltronVoiceForegroundService.setSpeakingState(getContext(), true);
        Locale locale = "en-US".equals(lang) ? Locale.US : new Locale("hi", "IN");
        int langRes = nativeTts.setLanguage(locale);
        if (langRes == TextToSpeech.LANG_MISSING_DATA || langRes == TextToSpeech.LANG_NOT_SUPPORTED) {
            nativeTts.setLanguage(Locale.US);
        }
        nativeTts.setSpeechRate(Math.max(0.75f, Math.min(1.4f, rate)));
        nativeTts.setPitch(Math.max(0.55f, Math.min(1.0f, pitch)));
        nativeTts.speak(text.trim(), TextToSpeech.QUEUE_FLUSH, null, "ultron_" + System.currentTimeMillis());

        JSObject ret = new JSObject();
        ret.put("spoken", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopSpeakingNative(PluginCall call) {
        if (nativeTts != null) {
            try {
                nativeTts.stop();
            } catch (Exception ignored) {}
        }
        UltronVoiceForegroundService.setSpeakingState(getContext(), false);
        call.resolve();
    }

    @PluginMethod
    public void setAssistantSpeaking(PluginCall call) {
        boolean speaking = Boolean.TRUE.equals(call.getBoolean("speaking", false));
        UltronVoiceForegroundService.setSpeakingState(getContext(), speaking);
        call.resolve();
    }

    @PluginMethod
    public void startBackgroundAssistant(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission must be granted before starting background voice assistant.");
            return;
        }
        String wakeWord = call.getString("wakeWord", "Hey Ultron");
        String lang = call.getString("lang", "hi-IN");
        boolean wakeWordEnabled = Boolean.TRUE.equals(call.getBoolean("wakeWordEnabled", true));

        Intent serviceIntent = new Intent(getContext(), UltronVoiceForegroundService.class);
        serviceIntent.setAction(UltronVoiceForegroundService.ACTION_START);
        serviceIntent.putExtra("wakeWord", wakeWord);
        serviceIntent.putExtra("lang", lang);
        serviceIntent.putExtra("wakeWordEnabled", wakeWordEnabled);
        ContextCompat.startForegroundService(getContext(), serviceIntent);

        JSObject ret = new JSObject();
        ret.put("running", true);
        ret.put("status", wakeWordEnabled ? "wake_listening" : "listening");
        ret.put("wakeWord", wakeWord);
        call.resolve(ret);
    }

    @PluginMethod
    public void updateBackgroundAssistant(PluginCall call) {
        if (!UltronVoiceForegroundService.isServiceRunning) {
            JSObject ret = new JSObject();
            ret.put("running", false);
            ret.put("status", "idle");
            call.resolve(ret);
            return;
        }
        String wakeWord = call.getString("wakeWord", UltronVoiceForegroundService.currentWakePhrase);
        String lang = call.getString("lang", "hi-IN");
        boolean wakeWordEnabled = Boolean.TRUE.equals(call.getBoolean("wakeWordEnabled", UltronVoiceForegroundService.wakeWordActive));

        Intent serviceIntent = new Intent(getContext(), UltronVoiceForegroundService.class);
        serviceIntent.setAction(UltronVoiceForegroundService.ACTION_UPDATE_CONFIG);
        serviceIntent.putExtra("wakeWord", wakeWord);
        serviceIntent.putExtra("lang", lang);
        serviceIntent.putExtra("wakeWordEnabled", wakeWordEnabled);
        getContext().startService(serviceIntent);

        JSObject ret = new JSObject();
        ret.put("running", true);
        ret.put("status", wakeWordEnabled ? "wake_listening" : "listening");
        ret.put("wakeWord", wakeWord);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopBackgroundAssistant(PluginCall call) {
        UltronVoiceForegroundService.stopFromApp(getContext());

        JSObject ret = new JSObject();
        ret.put("running", false);
        ret.put("status", "idle");
        call.resolve(ret);
    }

    @PluginMethod
    public void getAssistantServiceStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", UltronVoiceForegroundService.isServiceRunning);
        ret.put("status", UltronVoiceForegroundService.currentServiceStatus);
        ret.put("wakeWord", UltronVoiceForegroundService.currentWakePhrase);
        ret.put("wakeWordEnabled", UltronVoiceForegroundService.wakeWordActive);
        ret.put("commandArmed", UltronVoiceForegroundService.isCommandArmed);
        call.resolve(ret);
    }
}
