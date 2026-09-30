package com.echolocate.app

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File
import java.io.FileOutputStream

class AssetCopyModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AssetCopy"
    }

    @ReactMethod
    fun copyAssetToCache(assetName: String, promise: Promise) {
        try {
            val context = reactApplicationContext
            val cacheFile = File(context.cacheDir, assetName)
            cacheFile.parentFile?.mkdirs()
            
            val assetFd = try { context.assets.openFd(assetName) } catch (e: Exception) { null }
            val assetLength = assetFd?.length ?: -1L
            try { assetFd?.close() } catch (e: Exception) {}

            val needsCopy = !cacheFile.exists() || 
                            cacheFile.length() <= 0L || 
                            (assetLength > 0 && cacheFile.length() != assetLength)

            if (needsCopy) {
                context.assets.open(assetName).use { inputStream ->
                    FileOutputStream(cacheFile).use { outputStream ->
                        inputStream.copyTo(outputStream)
                    }
                }
            }

            copyCompanionDataIfNeeded(context, assetName, cacheFile.parentFile)
            
            promise.resolve(cacheFile.absolutePath)
        } catch (e: Exception) {
            promise.reject("COPY_ERROR", "Failed to copy asset '$assetName': ${e.message ?: e.javaClass.simpleName}", e)
        }
    }

    private fun copyCompanionDataIfNeeded(
        context: ReactApplicationContext,
        assetName: String,
        destinationDir: File?
    ) {
        if (!assetName.endsWith(".onnx")) {
            return
        }

        val dataAssetName = "$assetName.data"
        val dataCacheFile = destinationDir?.let { File(it, dataAssetName) } ?: return
        dataCacheFile.parentFile?.mkdirs()
        val dataFd = try { context.assets.openFd(dataAssetName) } catch (e: Exception) { null }
        val dataLength = dataFd?.length ?: -1L
        try { dataFd?.close() } catch (e: Exception) {}

        val needsCopy = !dataCacheFile.exists() || 
                        dataCacheFile.length() <= 0L || 
                        (dataLength > 0 && dataCacheFile.length() != dataLength)

        if (needsCopy) {
            try {
                context.assets.open(dataAssetName).use { inputStream ->
                    FileOutputStream(dataCacheFile).use { outputStream ->
                        inputStream.copyTo(outputStream)
                    }
                }
            } catch (e: Exception) {
                // Companion data might not exist for some single-file models
            }
        }
    }
}
