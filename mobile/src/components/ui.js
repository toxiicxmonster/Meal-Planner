// Shared look: colors, buttons, chips, segmented controls, photos, sheets and the toast.
import React, { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { MP } from "../lib/planner";

export const C = {
  bg: "#FFF8F1", card: "#FFFFFF", border: "#EFE3D6", text: "#2F2A26", muted: "#8C8279",
  accent: "#E4572E", accentDark: "#C0441F", accentSoft: "#FDE7DF", green: "#3D9A5B",
  ghost: "#F3ECE4", ghostDark: "#E6DCD1",
};
const PASTELS = ["#F6C9A8", "#F4D58D", "#B8DDB1", "#A9D3E8", "#D5C1EC", "#F2B8C6", "#C9D7A6"];

export const tap = () => { if (Platform.OS === "ios") Haptics.selectionAsync().catch(() => {}); };

export function Button({ title, onPress, kind = "ghost", small, icon, disabled, style, flex }) {
  const k = {
    primary: [C.accent, "#fff"], soft: [C.accentSoft, C.accentDark], ghost: [C.ghost, C.text], done: [C.accent, "#fff"],
    danger: [C.accentSoft, C.accentDark],
  }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => { tap(); onPress && onPress(); }}
      style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: k[0], opacity: disabled ? 0.55 : pressed ? 0.75 : 1 },
        flex && { flex: 1 }, style]}>
      {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={k[1]} style={{ marginRight: title ? 5 : 0 }} /> : null}
      {title ? <Text style={[s.btnText, small && { fontSize: 13 }, { color: k[1] }]} numberOfLines={1}>{title}</Text> : null}
    </Pressable>
  );
}

export function Chip({ label, on, off, onPress }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }}
      style={[s.chip, on && { backgroundColor: C.accentSoft, borderColor: C.accentSoft },
        off && { backgroundColor: C.accentSoft, borderColor: C.accent }]}>
      <Text style={[s.chipText, (on || off) && { color: C.accentDark }, off && { textDecorationLine: "line-through" }]}>
        {off ? "✕ " : ""}{label}
      </Text>
    </Pressable>
  );
}

export function Segmented({ options, value, onChange, style }) {
  return (
    <View style={[s.seg, style]}>
      {options.map(([key, label]) => (
        <Pressable key={String(key)} onPress={() => { tap(); onChange(key); }} style={[s.segItem, value === key && s.segOn]}>
          <Text style={[s.segText, value === key && { color: C.accentDark, fontWeight: "700" }]} numberOfLines={1}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Title({ title, subtitle, right }) {
  return (
    <View style={s.titleRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.h1}>{title}</Text>
        {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export const Empty = ({ text }) => <Text style={s.empty}>{text}</Text>;

/** Meal photo, or a colored first-letter tile when there's no photo (or it fails to load). */
export function MealPhoto({ meal, style, big }) {
  const [failed, setFailed] = useState(false);
  const name = (meal && meal.name) || "?";
  const url = meal && MP.thumbUrl(meal.thumb, big);
  if (!url || failed) {
    const color = PASTELS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PASTELS.length];
    return (
      <View style={[s.ph, { backgroundColor: color }, style]}>
        <Text style={s.phText}>{name.trim().charAt(0).toUpperCase() || "?"}</Text>
      </View>
    );
  }
  return <Image source={{ uri: url }} style={[s.photo, style]} contentFit="cover" cachePolicy="disk" transition={150}
    onError={() => setFailed(true)} accessibilityIgnoresInvertColors />;
}

/** A native-style sheet that slides up (iOS page sheet). */
export function Sheet({ visible, onClose, title, children, footer, scroll = true }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={onClose}>
      <View style={[s.sheet, { paddingTop: Platform.OS === "ios" ? 8 : insets.top }]}>
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle} numberOfLines={2}>{title}</Text>
          <Pressable onPress={onClose} style={s.close} accessibilityLabel="Close" hitSlop={10}>
            <Ionicons name="close" size={20} color={C.text} />
          </Pressable>
        </View>
        {scroll ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : <View style={{ flex: 1 }}>{children}</View>}
        {footer ? <View style={[s.sheetFoot, { paddingBottom: 12 + insets.bottom }]}>{footer}</View> : null}
      </View>
    </Modal>
  );
}

export function Toast({ message }) {
  const insets = useSafeAreaInsets();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[s.toast, { bottom: 90 + insets.bottom }]}>
      <Text style={s.toastText}>{message}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16, paddingBottom: 32 },
  h1: { fontSize: 28, fontWeight: "800", color: C.text },
  h2: { fontSize: 20, fontWeight: "800", color: C.text },
  h3: { fontSize: 16, fontWeight: "800", color: C.accentDark, marginTop: 18, marginBottom: 6 },
  sub: { fontSize: 14, color: C.muted, marginTop: 2 },
  muted: { color: C.muted },
  small: { fontSize: 12 },
  body: { fontSize: 15, color: C.text, lineHeight: 21 },
  titleRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", borderRadius: 11, paddingHorizontal: 14, minHeight: 42 },
  btnSmall: { paddingHorizontal: 10, minHeight: 34, borderRadius: 9 },
  btnText: { fontSize: 15, fontWeight: "700" },
  chip: { borderWidth: 1, borderColor: C.border, backgroundColor: C.card, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7, marginRight: 6 },
  chipText: { fontSize: 13, fontWeight: "600", color: C.text },
  seg: { flexDirection: "row", backgroundColor: C.ghost, borderRadius: 11, padding: 3 },
  segItem: { flex: 1, alignItems: "center", paddingVertical: 8, paddingHorizontal: 6, borderRadius: 9 },
  segOn: { backgroundColor: C.card, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  segText: { fontSize: 13, color: C.muted, fontWeight: "600" },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, overflow: "hidden" },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: C.text },
  label: { fontSize: 14, fontWeight: "700", color: C.text, marginBottom: 6, marginTop: 14 },
  empty: { textAlign: "center", color: C.muted, paddingVertical: 48, paddingHorizontal: 16, fontSize: 15, lineHeight: 22 },
  photo: { backgroundColor: C.ghost },
  ph: { alignItems: "center", justifyContent: "center" },
  phText: { color: "#fff", fontWeight: "800", fontSize: 26 },
  sheet: { flex: 1, backgroundColor: C.card },
  sheetHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetTitle: { flex: 1, fontSize: 19, fontWeight: "800", color: C.text },
  close: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.ghost, alignItems: "center", justifyContent: "center" },
  sheetFoot: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card },
  toast: { position: "absolute", left: 20, right: 20, alignItems: "center" },
  toastText: { backgroundColor: C.text, color: C.bg, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12, fontSize: 14, overflow: "hidden", textAlign: "center" },
});
