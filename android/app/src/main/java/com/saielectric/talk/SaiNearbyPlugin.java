package com.saielectric.talk;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Phone-to-phone link for Sai Talk using Google Nearby Connections (Bluetooth + Wi-Fi, no internet).
 * Implements the PeerLink contract of the web app's mesh core:
 *   start({name}) / stop() / broadcast({data}) / send({peer,data})   (data = base64)
 *   events: packet {peer,data}, peerUp {peer}, peerDown {peer}, error {detail}, tick {}
 * The app is NOT verified on real phones yet: range, speed and battery are unmeasured.
 */
@CapacitorPlugin(name = "SaiNearby")
public class SaiNearbyPlugin extends Plugin {
    private static final String SERVICE_ID = "com.saielectric.talk.mesh";
    private static final int PERM_CODE = 4242;
    private static final long REQUEST_RETRY_MS = 6000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private ConnectionsClient client;
    private String myName = "";
    private boolean running = false;
    private int ticks = 0;
    private final Set<String> connected = ConcurrentHashMap.newKeySet();
    private final Map<String, String> known = new ConcurrentHashMap<>();       // discovered endpoint -> name
    private final Map<String, Long> requestedAt = new ConcurrentHashMap<>();   // endpoint -> last request time

    // ---------------- permissions ----------------
    private List<String> needed() {
        List<String> p = new ArrayList<>();
        p.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33) {
            p.add(Manifest.permission.POST_NOTIFICATIONS);
            p.add("android.permission.NEARBY_WIFI_DEVICES");
        }
        if (Build.VERSION.SDK_INT >= 31) {
            p.add("android.permission.BLUETOOTH_SCAN");
            p.add("android.permission.BLUETOOTH_ADVERTISE");
            p.add("android.permission.BLUETOOTH_CONNECT");
        }
        if (Build.VERSION.SDK_INT <= 31) p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        return p;
    }

    private List<String> missing() {
        List<String> m = new ArrayList<>();
        for (String p : needed()) {
            if (ContextCompat.checkSelfPermission(getContext(), p) != PackageManager.PERMISSION_GRANTED) m.add(p);
        }
        return m;
    }

    @PluginMethod
    public void permissions(PluginCall call) {
        List<String> m = missing();
        JSObject o = new JSObject();
        o.put("granted", m.isEmpty());
        JSArray arr = new JSArray();
        for (String s : m) arr.put(s);
        o.put("missing", arr);
        call.resolve(o);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        List<String> m = missing();
        if (!m.isEmpty() && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), m.toArray(new String[0]), PERM_CODE);
        }
        call.resolve();
    }

    // ---------------- lifecycle ----------------
    @PluginMethod
    public void start(PluginCall call) {
        if (running) { call.resolve(); return; }
        List<String> m = missing();
        if (!m.isEmpty()) { call.reject("permissions: " + m); return; }
        myName = call.getString("name", "sai");
        try {
            Intent svc = new Intent(getContext(), SaiTalkService.class);
            ContextCompat.startForegroundService(getContext(), svc);
        } catch (Exception e) {
            call.reject("service: " + e.getMessage()); return;
        }
        client = Nearby.getConnectionsClient(getContext());
        running = true; ticks = 0;
        client.startAdvertising(myName, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
            .addOnFailureListener(e -> fail("advertise", e));
        client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
            .addOnFailureListener(e -> fail("discover", e));
        main.postDelayed(ticker, 1000);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        halt();
        call.resolve();
    }

    private void halt() {
        running = false;
        main.removeCallbacks(ticker);
        if (client != null) {
            try { client.stopAdvertising(); } catch (Exception ignored) { }
            try { client.stopDiscovery(); } catch (Exception ignored) { }
            try { client.stopAllEndpoints(); } catch (Exception ignored) { }
        }
        connected.clear(); known.clear(); requestedAt.clear();
        try {
            Intent svc = new Intent(getContext(), SaiTalkService.class).setAction("stop");
            getContext().startService(svc);
        } catch (Exception ignored) { }
    }

    @Override
    protected void handleOnDestroy() {
        if (running) halt();
        super.handleOnDestroy();
    }

    private void fail(String what, Exception e) {
        String msg = e.getMessage() == null ? "" : e.getMessage();
        if (msg.contains("STATUS_ALREADY_ADVERTISING") || msg.contains("STATUS_ALREADY_DISCOVERING")) return;
        JSObject o = new JSObject();
        o.put("detail", what + ": " + msg);
        notifyListeners("error", o);
    }

    // ---------------- sending ----------------
    @PluginMethod
    public void broadcast(PluginCall call) {
        String d = call.getString("data");
        if (d != null && client != null && running && !connected.isEmpty()) {
            try { client.sendPayload(new ArrayList<>(connected), Payload.fromBytes(Base64.decode(d, Base64.NO_WRAP))); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String peer = call.getString("peer"), d = call.getString("data");
        if (peer != null && d != null && client != null && running && connected.contains(peer)) {
            try { client.sendPayload(peer, Payload.fromBytes(Base64.decode(d, Base64.NO_WRAP))); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    // ---------------- clock + connection upkeep ----------------
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!running) return;
            notifyListeners("tick", new JSObject());
            if (++ticks % 3 == 0) connectKnown();
            main.postDelayed(this, 1000);
        }
    };

    /** Of any two phones, only the one with the smaller name asks, so both never ask at once. */
    private void connectKnown() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, String> e : known.entrySet()) {
            String id = e.getKey();
            if (connected.contains(id) || myName.compareTo(e.getValue()) >= 0) continue;
            Long last = requestedAt.get(id);
            if (last != null && now - last < REQUEST_RETRY_MS) continue;
            requestedAt.put(id, now);
            client.requestConnection(myName, id, lifecycle).addOnFailureListener(ex -> {
                String m = ex.getMessage() == null ? "" : ex.getMessage();
                if (!m.contains("STATUS_ALREADY_CONNECTED") && !m.contains("STATUS_OUT_OF_ORDER_API_CALL")) fail("connect", ex);
            });
        }
    }

    // ---------------- Nearby callbacks ----------------
    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override public void onEndpointFound(String id, DiscoveredEndpointInfo info) {
            known.put(id, info.getEndpointName());
            connectKnown();
        }
        @Override public void onEndpointLost(String id) { known.remove(id); requestedAt.remove(id); }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override public void onConnectionInitiated(String id, ConnectionInfo info) {
            // Accept every link. Anyone nearby can open a link, but only devices holding a certificate signed by
            // our server and the channel key can speak or be heard; the mesh layer drops everything else.
            client.acceptConnection(id, payloads);
        }
        @Override public void onConnectionResult(String id, ConnectionResolution r) {
            if (r.getStatus().getStatusCode() == ConnectionsStatusCodes.STATUS_OK) {
                connected.add(id);
                JSObject o = new JSObject(); o.put("peer", id); notifyListeners("peerUp", o);
            } else {
                requestedAt.remove(id);
            }
        }
        @Override public void onDisconnected(String id) {
            if (connected.remove(id)) { JSObject o = new JSObject(); o.put("peer", id); notifyListeners("peerDown", o); }
            requestedAt.remove(id);
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override public void onPayloadReceived(String id, Payload p) {
            if (p.getType() != Payload.Type.BYTES || p.asBytes() == null) return;
            JSObject o = new JSObject();
            o.put("peer", id);
            o.put("data", Base64.encodeToString(p.asBytes(), Base64.NO_WRAP));
            notifyListeners("packet", o);
        }
        @Override public void onPayloadTransferUpdate(String id, PayloadTransferUpdate u) { }
    };
}
