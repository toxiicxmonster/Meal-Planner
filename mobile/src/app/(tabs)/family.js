// Family: join with an invite (QR code or code), see members, invite people, and sync status.
// There are no emails or passwords: the phone signs itself in. Families are started on the desktop app;
// the first phone to join is the primary household member, who can invite and remove people too.
import React, { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import * as Linking from "expo-linking";
import Svg, { Path, Rect } from "react-native-svg";
import makeQr from "qrcode-generator";
import { Ionicons } from "@expo/vector-icons";
import { MP, usePlanner } from "../../lib/planner";
import { Button, C, Title, s } from "../../components/ui";

export default function FamilyScreen() {
  const P = usePlanner();
  useFocusEffect(React.useCallback(() => { P.refreshFamily(); }, [P]));
  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
        <Title title="Family" subtitle="Share one week plan, favorites and shopping list." />
        {!P.familyConfigured ? <NotConfigured /> : !P.S.family ? <JoinBox /> : <Members />}
        <Recipes />
      </ScrollView>
    </SafeAreaView>
  );
}

function Box({ children, style }) {
  return <View style={[s.card, { padding: 16, marginBottom: 14 }, style]}>{children}</View>;
}

/** Runs an async action with a spinner and shows its error message. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message || "Something went wrong."); } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

const ErrorText = ({ error }) => (error ? <Text style={{ color: C.accentDark, marginTop: 10, fontWeight: "600" }}>{error}</Text> : null);

function NotConfigured() {
  return (
    <Box>
      <Text style={[s.h2, { fontSize: 17 }]}>Family sharing isn’t set up yet</Text>
      <Text style={[s.body, { marginTop: 6 }]}>
        This copy of the app hasn’t been connected to a Supabase project. Everything else works and is saved on this phone.
        {"\n\n"}Setting it up: see “Set up family sharing” in the project README.
      </Text>
    </Box>
  );
}

/** Invite code + family member name. The phone signs itself in; there's no email or password. */
function JoinBox() {
  const P = usePlanner();
  const invited = !!P.S.pendingInvite;
  const [code, setCode] = useState(invited ? MP.formatInviteCode(P.S.pendingInvite) : "");
  const [name, setName] = useState("");
  const a = useAction();
  return (
    <Box style={invited && { borderColor: C.accent, borderWidth: 2 }}>
      <Text style={[s.h2, { fontSize: 17 }]}>{invited ? "You’ve been invited to a family" : "Join your family"}</Text>
      <Text style={[s.muted, { marginTop: 4 }]}>
        Everyone in a family shares the same week, favorites and shopping list. Families are set up on the Meal Planner
        desktop app — scan the QR code it shows (or the primary household member’s), or type the invite code here.
      </Text>
      <Text style={s.label}>Invite code</Text>
      <TextInput style={[s.input, { fontSize: 20, letterSpacing: 3, textAlign: "center" }]} value={code} onChangeText={setCode}
        placeholder="ABCD-2345" placeholderTextColor={C.ghostDark} autoCapitalize="characters" autoCorrect={false} />
      <Text style={s.label}>Family member name</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. Sam" placeholderTextColor={C.muted}
        textContentType="givenName" autoFocus={invited} />
      <Button style={{ marginTop: 14 }} kind="primary" title="Join family"
        disabled={a.busy || code.replace(/[^A-Za-z0-9]/g, "").length < 8 || !name.trim()} onPress={() => a.run(() => P.joinWithInvite(code, name))} />
      <Text style={[s.muted, s.small, { marginTop: 8 }]}>No email or password needed. The family’s week plan replaces the one on this phone; your favorites and list items are added to the family’s.</Text>
      {a.busy ? <ActivityIndicator style={{ marginTop: 10 }} color={C.accent} /> : null}
      <ErrorText error={a.error} />
    </Box>
  );
}

/** A QR code another phone's camera can scan. */
function QrCode({ text, size = 220 }) {
  const qr = React.useMemo(() => MP.qrSvgPath(makeQr, text), [text]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`} accessibilityLabel="Invite QR code">
      <Rect width={qr.size} height={qr.size} fill="#fff" />
      <Path d={qr.path} fill="#000" />
    </Svg>
  );
}

function Members() {
  const P = usePlanner();
  const fam = P.S.family;
  const me = fam.members.find((m) => m.me) || {};
  const manager = MP.canManage(fam);
  const [invite, setInvite] = useState(null);
  const [name, setName] = useState(me.display_name || "");
  const a = useAction();
  const link = (code) => P.inviteLink(code) || Linking.createURL("join/" + code);

  const shareInvite = (code) => Share.share({ message: `Join our family on Meal Planner!\n\nTap this link on your phone: ${link(code)}\n\n`
    + `Or open the app, go to Family and enter the invite code ${MP.formatInviteCode(code)}. It works for 7 days.` }).catch(() => {});

  const syncText = P.S.syncState === "ok" ? `Synced ${P.S.lastSync ? "at " + new Date(P.S.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}`
    : P.S.syncState === "syncing" ? "Syncing…" : P.S.syncState === "error" ? P.S.syncDetail : "Not synced yet";

  return (
    <>
      <Box>
        <View style={s.row}>
          <Ionicons name="people" size={22} color={C.accent} />
          <Text style={[s.h2, { flex: 1 }]} numberOfLines={1}>{fam.name}</Text>
        </View>
        <View style={[s.row, { marginTop: 6 }]}>
          <Ionicons name={P.S.syncState === "error" ? "cloud-offline-outline" : "cloud-done-outline"} size={16}
            color={P.S.syncState === "error" ? C.accentDark : C.green} />
          <Text style={[s.small, { flex: 1, color: P.S.syncState === "error" ? C.accentDark : C.muted }]}>{syncText}</Text>
          <Button small title="Sync now" icon="refresh" onPress={P.syncNow} />
        </View>
        <Text style={[s.h3, { marginTop: 16 }]}>Members</Text>
        {fam.members.map((m) => (
          <View key={m.user_id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 }}>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.accentSoft, alignItems: "center", justifyContent: "center" }}>
              {m.role === "owner" ? <Ionicons name="desktop-outline" size={17} color={C.accentDark} />
                : <Text style={{ color: C.accentDark, fontWeight: "800" }}>{(m.display_name || "?").charAt(0).toUpperCase()}</Text>}
            </View>
            <Text style={[s.body, { flex: 1 }]}>{m.display_name || "(no name)"}{m.me ? <Text style={s.muted}>  (you)</Text> : null}</Text>
            {MP.ROLE_LABELS[m.role] ? <Text style={[s.small, { color: C.accentDark, fontWeight: "700" }]}>{MP.ROLE_LABELS[m.role]}</Text> : null}
            {manager && !m.me && m.role !== "owner" ? (
              <Pressable hitSlop={10} accessibilityLabel={`Remove ${m.display_name}`} onPress={() => Alert.alert(`Remove ${m.display_name || "this person"}?`,
                "They'll stop seeing the family's plan and list. Their phone keeps its own copy.",
                [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => a.run(() => P.removeMember(m.user_id)) }])}>
                <Ionicons name="person-remove-outline" size={20} color={C.muted} />
              </Pressable>
            ) : null}
          </View>
        ))}
        {fam.role === "primary" ? (
          <Text style={[s.muted, s.small, { marginTop: 10 }]}>You’re the primary household member: you can invite people and remove them.</Text>
        ) : null}
        {manager ? (
          <Button title="Invite someone" icon="qr-code-outline" kind="primary" style={{ marginTop: 14 }} disabled={a.busy}
            onPress={() => a.run(async () => setInvite(await P.createInvite()))} />
        ) : null}
        {invite ? (
          <View style={{ marginTop: 12, backgroundColor: C.accentSoft, borderRadius: 12, padding: 14, alignItems: "center" }}>
            <Text style={[s.small, { color: C.accentDark, fontWeight: "700" }]}>SCAN WITH A PHONE’S CAMERA TO JOIN</Text>
            <View style={{ marginVertical: 10, borderRadius: 8, overflow: "hidden" }}><QrCode text={link(invite.code)} /></View>
            <Text style={[s.small, { color: C.accentDark, fontWeight: "700" }]}>INVITE CODE</Text>
            <Text selectable style={{ fontSize: 30, fontWeight: "800", letterSpacing: 3, color: C.text, marginVertical: 4 }}>{MP.formatInviteCode(invite.code)}</Text>
            <Text style={[s.muted, s.small, { textAlign: "center" }]}>Works for 7 days, for as many family members as you like.</Text>
            <Button small title="Send invite…" icon="share-outline" style={{ marginTop: 8 }} onPress={() => shareInvite(invite.code)} />
          </View>
        ) : null}
        {a.busy ? <ActivityIndicator style={{ marginTop: 10 }} color={C.accent} /> : null}
        <ErrorText error={a.error} />
      </Box>
      <Box>
        <Text style={s.label}>Family member name</Text>
        <View style={s.row}>
          <TextInput style={[s.input, { flex: 1 }]} value={name} onChangeText={setName} placeholderTextColor={C.muted} placeholder="e.g. Sam" />
          <Button title="Save" disabled={!name.trim() || name === me.display_name} onPress={() => a.run(() => P.setDisplayName(name))} />
        </View>
        <Button title="Leave family" icon="exit-outline" kind="danger" style={{ marginTop: 14 }} onPress={() => Alert.alert("Leave this family?",
          fam.role === "primary" && fam.members.length > 2
            ? "Someone else becomes the primary household member. Your meals stay on this phone. To come back you'll need a new invite."
            : "Your meals stay on this phone. To come back you'll need a new invite.",
          [{ text: "Cancel", style: "cancel" }, { text: "Leave", style: "destructive", onPress: () => a.run(P.leaveFamily) }])} />
      </Box>
    </>
  );
}

function Recipes() {
  const P = usePlanner();
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={[s.muted, s.small]}>
        {P.S.catalog.length ? `${P.S.catalog.length} recipes from TheMealDB, loaded live.` : "Recipes load live from TheMealDB."}
      </Text>
      <Button small title="Reload recipes" icon="refresh" style={{ alignSelf: "flex-start", marginTop: 8 }}
        disabled={P.S.catalogLoading} onPress={P.reloadCatalog} />
    </View>
  );
}
