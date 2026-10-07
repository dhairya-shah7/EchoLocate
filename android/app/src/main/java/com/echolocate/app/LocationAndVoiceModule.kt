package com.echolocate.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.util.Locale

class LocationAndVoiceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var speechRecognizer: SpeechRecognizer? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun getName(): String {
        return "LocationAndVoice"
    }

    @ReactMethod
    fun enableCoPilotAudioMode(promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (audioManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                val focusReq = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener { }
                    .build()
                audioManager.requestAudioFocus(focusReq)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getCurrentLocation(promise: Promise) {
        try {
            val context = reactApplicationContext
            val hasFine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val hasCoarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

            if (!hasFine && !hasCoarse) {
                promise.reject("PERMISSION_DENIED", "Location permission not granted")
                return
            }

            val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            if (locationManager == null) {
                promise.reject("LOCATION_UNAVAILABLE", "LocationManager unavailable")
                return
            }

            val providers = listOf(
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER
            )

            var bestLocation: Location? = null
            for (provider in providers) {
                try {
                    if (locationManager.isProviderEnabled(provider)) {
                        val loc = locationManager.getLastKnownLocation(provider)
                        if (loc != null) {
                            if (bestLocation == null || loc.time > bestLocation!!.time) {
                                bestLocation = loc
                            }
                        }
                    }
                } catch (_: SecurityException) {}
            }

            if (bestLocation != null) {
                val map = Arguments.createMap()
                map.putDouble("latitude", bestLocation.latitude)
                map.putDouble("longitude", bestLocation.longitude)
                map.putDouble("speed", bestLocation.speed.toDouble())
                map.putDouble("bearing", bestLocation.bearing.toDouble())
                map.putDouble("accuracy", bestLocation.accuracy.toDouble())
                promise.resolve(map)
                return
            }

            // Request a single quick update on main thread with a 2.5s timeout fallback
            UiThreadUtil.runOnUiThread {
                var resolved = false
                val listener = object : LocationListener {
                    override fun onLocationChanged(loc: Location) {
                        if (!resolved) {
                            resolved = true
                            try { locationManager.removeUpdates(this) } catch (_: Exception) {}
                            val map = Arguments.createMap()
                            map.putDouble("latitude", loc.latitude)
                            map.putDouble("longitude", loc.longitude)
                            map.putDouble("speed", loc.speed.toDouble())
                            map.putDouble("bearing", loc.bearing.toDouble())
                            map.putDouble("accuracy", loc.accuracy.toDouble())
                            promise.resolve(map)
                        }
                    }
                    override fun onProviderEnabled(provider: String) {}
                    override fun onProviderDisabled(provider: String) {}
                    @Deprecated("Deprecated in Java")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                }

                try {
                    val activeProvider = when {
                        locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                        locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                        else -> null
                    }
                    if (activeProvider != null) {
                        locationManager.requestLocationUpdates(activeProvider, 0L, 0f, listener, Looper.getMainLooper())
                    }
                } catch (_: Exception) {}

                mainHandler.postDelayed({
                    if (!resolved) {
                        resolved = true
                        try { locationManager.removeUpdates(listener) } catch (_: Exception) {}
                        promise.reject("TIMEOUT", "GPS signal acquiring")
                    }
                }, 2500L)
            }
        } catch (e: Exception) {
            promise.reject("LOCATION_ERROR", e.message ?: "Location error", e)
        }
    }

    @ReactMethod
    fun launchGoogleMapsWalking(destinationQuery: String, promise: Promise) {
        try {
            val encoded = Uri.encode(destinationQuery.ifBlank { "nearest bus stop" })
            val navUri = Uri.parse("google.navigation:q=$encoded&mode=w")
            val mapIntent = Intent(Intent.ACTION_VIEW, navUri).apply {
                setPackage("com.google.android.apps.maps")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            val context = reactApplicationContext
            if (mapIntent.resolveActivity(context.packageManager) != null) {
                context.startActivity(mapIntent)
                promise.resolve("GOOGLE_MAPS_APP")
            } else {
                val webUri = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$encoded&travelmode=walking")
                val webIntent = Intent(Intent.ACTION_VIEW, webUri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(webIntent)
                promise.resolve("GOOGLE_MAPS_WEB")
            }
        } catch (e: Exception) {
            promise.reject("MAPS_LAUNCH_ERROR", e.message ?: "Unable to launch Google Maps", e)
        }
    }

    @ReactMethod
    fun listenVoiceCommand(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val context = reactApplicationContext
                if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                    promise.reject("SPEECH_UNAVAILABLE", "Speech recognition service not available on device")
                    return@runOnUiThread
                }

                speechRecognizer?.destroy()
                val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
                speechRecognizer = recognizer

                var finished = false
                val completeOnce = { transcript: String?, errCode: String?, errMsg: String? ->
                    if (!finished) {
                        finished = true
                        try {
                            recognizer.stopListening()
                            recognizer.destroy()
                        } catch (_: Exception) {}
                        speechRecognizer = null
                        if (transcript != null) {
                            promise.resolve(transcript)
                        } else {
                            promise.reject(errCode ?: "VOICE_ERROR", errMsg ?: "No voice command recognized")
                        }
                    }
                }

                recognizer.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) {
                        completeOnce(null, "SPEECH_ERR_$error", "Could not hear voice command clearly")
                    }
                    override fun onResults(results: Bundle?) {
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val top = matches?.firstOrNull()
                        if (!top.isNullOrBlank()) {
                            completeOnce(top, null, null)
                        } else {
                            completeOnce(null, "EMPTY_SPEECH", "No words detected")
                        }
                    }
                    override fun onPartialResults(partialResults: Bundle?) {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
                }

                recognizer.startListening(intent)

                mainHandler.postDelayed({
                    completeOnce(null, "SPEECH_TIMEOUT", "Voice command listening timed out")
                }, 5000L)
            } catch (e: Exception) {
                promise.reject("VOICE_INIT_ERROR", e.message ?: "Failed to start voice listener", e)
            }
        }
    }
}
