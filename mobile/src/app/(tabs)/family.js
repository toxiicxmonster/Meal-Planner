// Family: sign in, create or join a family, invite people, see members, and sync status.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import * as Linking from "expo-linking";
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
        {!P.familyConfigured ? <NotConfigured /> : !P.S.session ? <SignIn /> : !P.S.family ? <StartOrJoin /> : <Members />}
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

function SignIn() {
  const P = usePlanner();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction();
  return (
    <Box>
      <Text style={[s.h2, { fontSize: 17 }]}>{sent ? "Check your email" : "Sign in"}</Text>
      <Text style={[s.muted, { marginTop: 4 }]}>
        {sent ? `We sent a 6-digit code to ${email}. Enter it below.` : "No password needed — we'll email you a code."}
      </Text>
      {!sent ? (
        <>
          <TextInput style={[s.input, { marginTop: 14 }]} value={email} onChangeText={setEmail} placeholder="you@example.com"
            placeholderTextColor={C.muted} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
          <Button title="Email me a code" kind="primary" style={{ marginTop: 12 }} disabled={a.busy || !email.includes("@")}
            onPress={() => a.run(async () => { await P.sendCode(email); setSent(true); })} />
        </>
      ) : (
        <>
          <TextInput style={[s.input, { marginTop: 14, fontSize: 24, letterSpacing: 8, textAlign: "center" }]} value={code} onChangeText={setCode}
            placeholder="123456" placeholderTextColor={C.ghostDark} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={8} autoFocus />
          <Button title="Sign in" kind="primary" style={{ marginTop: 12 }} disabled={a.busy || code.length < 6}
            onPress={() => a.run(() => P.verifyCode(email, code))} />
          <View style={[s.row, { marginTop: 10 }]}>
            <Button small title="Send a new code" onPress={() => a.run(() => P.sendCode(email))} />
            <Button small title="Use a different email" onPress={() => { setSent(false); setCode(""); a.setError(null); }} />
          </View>
        </>
      )}
      {a.busy ? <ActivityIndicator style={{ marginTop: 10 }} color={C.accent} /> : null}
      <ErrorText error={a.error} />
    </Box>
  );
}

function StartOrJoin() {
  const P = usePlanner();
  const [mode, setMode] = useState(P.S.pendingInvite ? "join" : null);
  const [code, setCode] = useState(P.S.pendingInvite ? MP.formatInviteCode(P.S.pendingInvite) : "");
  const [familyName, setFamilyName] = useState("");
  const [yourName, setYourName] = useState("");
  const a = useAction();
  useEffect(() => { P.clearPendingInvite(); }, [P]);
  return (
    <>
      <Box>
        <Text style={s.muted}>Signed in as {P.S.session.email}</Text>
        <Text style={[s.h2, { fontSize: 17, marginTop: 8 }]}>Join or start a family</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>Everyone in a family shares the same week, favorites and shopping list.</Text>
        <View style={[s.row, { marginTop: 14 }]}>
          <Button flex title="Join a family" icon="enter-outline" kind={mode === "join" ? "primary" : "ghost"} onPress={() => setMode("join")} />
          <Button flex title="Start a family" icon="add" kind={mode === "create" ? "primary" : "ghost"} onPress={() => setMode("create")} />
        </View>
        {mode ? (
          <>
            {mode === "join" ? (
              <>
                <Text style={s.label}>Invite code</Text>
                <TextInput style={[s.input, { fontSize: 20, letterSpacing: 3, textAlign: "center" }]} value={code} onChangeText={setCode}
                  placeholder="ABCD-2345" placeholderTextColor={C.ghostDark} autoCapitalize="characters" autoCorrect={false} />
              </>
            ) : (
              <>
                <Text style={s.label}>Family name</Text>
                <TextInput style={s.input} value={familyName} onChangeText={setFamilyName} placeholder="e.g. The Smiths" placeholderTextColor={C.muted} />
              </>
            )}
            <Text style={s.label}>Your name <Text style={[s.muted, { fontWeight: "400" }]}>(so others know who’s who)</Text></Text>
            <TextInput style={s.input} value={yourName} onChangeText={setYourName} placeholder="e.g. Sam" placeholderTextColor={C.muted} textContentType="givenName" />
            <Button style={{ marginTop: 14 }} kind="primary" disabled={a.busy || (mode === "join" ? code.replace(/[^A-Za-z0-9]/g, "").length < 8 : !familyName.trim())}
              title={mode === "join" ? "Join family" : "Start family"}
              onPress={() => a.run(() => (mode === "join" ? P.joinFamily(code, yourName) : P.createFamily(familyName, yourName)))} />
            {mode === "join" ? <Text style={[s.muted, s.small, { marginTop: 8 }]}>The family’s week plan replaces the one on this phone. Your favorites and list items are added to the family’s.</Text>
              : <Text style={[s.muted, s.small, { marginTop: 8 }]}>Your current meals, favorites and list become the family’s.</Text>}
            {a.busy ? <ActivityIndicator style={{ marginTop: 10 }} color={C.accent} /> : null}
            <ErrorText error={a.error} />
          </>
        ) : null}
      </Box>
      <Button small title="Sign out" onPress={() => P.signOut()} style={{ alignSelf: "flex-start" }} />
    </>
  );
}

function Members() {
  const P = usePlanner();
  const fam = P.S.family;
  const me = fam.members.find((m) => m.me) || {};
  const isOwner = fam.role === "owner";
  const [invite, setInvite] = useState(null);
  const [name, setName] = useState(me.display_name || "");
  const a = useAction();

  const shareInvite = async (code) => {
    const pretty = MP.formatInviteCode(code);
    const link = Linking.createURL("join/" + code);
    await Share.share({ message: `Join our family on Meal Planner!\n\nOpen the app, go to Family and enter this invite code:\n${pretty}\n\nOr tap this link on your phone: ${link}\n\nThe code works for 7 days.` }).catch(() => {});
  };
  const makeInvite = () => a.run(async () => { const inv = await P.createInvite(); setInvite(inv); await shareInvite(inv.code); });

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
              <Text style={{ color: C.accentDark, fontWeight: "800" }}>{(m.display_name || "?").charAt(0).toUpperCase()}</Text>
            </View>
            <Text style={[s.body, { flex: 1 }]}>{m.display_name || "(no name)"}{m.me ? <Text style={s.muted}>  (you)</Text> : null}</Text>
            {m.role === "owner" ? <Text style={[s.small, { color: C.accentDark, fontWeight: "700" }]}>Owner</Text> : null}
            {isOwner && !m.me ? (
              <Pressable hitSlop={10} accessibilityLabel={`Remove ${m.display_name}`} onPress={() => Alert.alert(`Remove ${m.display_name || "this person"}?`,
                "They'll stop seeing the family's plan and list. Their phone keeps its own copy.",
                [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => a.run(() => P.removeMember(m.user_id)) }])}>
                <Ionicons name="person-remove-outline" size={20} color={C.muted} />
              </Pressable>
            ) : null}
          </View>
        ))}
        <Button title="Invite someone" icon="person-add-outline" kind="primary" style={{ marginTop: 14 }} disabled={a.busy} onPress={makeInvite} />
        {invite ? (
          <View style={{ marginTop: 12, backgroundColor: C.accentSoft, borderRadius: 12, padding: 14, alignItems: "center" }}>
            <Text style={[s.small, { color: C.accentDark, fontWeight: "700" }]}>INVITE CODE</Text>
            <Text selectable style={{ fontSize: 30, fontWeight: "800", letterSpacing: 3, color: C.text, marginVertical: 4 }}>{MP.formatInviteCode(invite.code)}</Text>
            <Text style={[s.muted, s.small, { textAlign: "center" }]}>Works for 7 days. They enter it on the Family tab after signing in.</Text>
            <Button small title="Share again" icon="share-outline" style={{ marginTop: 8 }} onPress={() => shareInvite(invite.code)} />
          </View>
        ) : null}
        {a.busy ? <ActivityIndicator style={{ marginTop: 10 }} color={C.accent} /> : null}
        <ErrorText error={a.error} />
      </Box>
      <Box>
        <Text style={s.label}>Your name in this family</Text>
        <View style={s.row}>
          <TextInput style={[s.input, { flex: 1 }]} value={name} onChangeText={setName} placeholderTextColor={C.muted} placeholder="e.g. Sam" />
          <Button title="Save" disabled={!name.trim() || name === me.display_name} onPress={() => a.run(() => P.setDisplayName(name))} />
        </View>
        <Text style={[s.muted, s.small, { marginTop: 12 }]}>Signed in as {P.S.session.email}</Text>
        <View style={[s.row, { marginTop: 12 }]}>
          <Button flex title="Leave family" icon="exit-outline" kind="danger" onPress={() => Alert.alert("Leave this family?",
            isOwner && fam.members.length > 1 ? "Someone else becomes the owner. Your meals stay on this phone." : "Your meals stay on this phone.",
            [{ text: "Cancel", style: "cancel" }, { text: "Leave", style: "destructive", onPress: () => a.run(P.leaveFamily) }])} />
          <Button flex title="Sign out" onPress={() => P.signOut()} />
        </View>
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
