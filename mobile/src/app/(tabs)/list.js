// Shopping list: grouped by aisle, tap to check off, quick-add, add the week's ingredients.
import React, { useRef, useState } from "react";
import { Pressable, SectionList, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MP, usePlanner } from "../../lib/planner";
import { Button, C, Empty, Title, s, tap } from "../../components/ui";
import { IngredientsSheet } from "../../components/sheets";

export default function ListScreen() {
  const P = usePlanner();
  const [text, setText] = useState("");
  const [weekOpen, setWeekOpen] = useState(false);
  const input = useRef(null);
  const items = P.S.data.shopping;
  const toBuy = items.filter((it) => !it.checked), done = items.filter((it) => it.checked);
  const sections = MP.AISLES
    .map((aisle) => ({ title: aisle, data: toBuy.filter((it) => (it.aisle || "Other") === aisle).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((sec) => sec.data.length);
  if (done.length) sections.push({ title: "In cart", data: done, done: true });

  const addWeek = () => {
    const d = P.S.data;
    if (!d.week.some(Boolean)) return P.notify("Plan some meals first");
    setWeekOpen(true);
  };
  const submit = () => {
    if (!text.trim()) return;
    P.quickAdd(text);
    setText("");
    setTimeout(() => input.current && input.current.focus(), 50);
  };

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <SectionList
        sections={sections}
        keyExtractor={(it) => it.uid}
        contentContainerStyle={s.pad}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View>
            <Title title="Shopping list" subtitle={items.length ? `${toBuy.length} to buy${done.length ? ` · ${done.length} in cart` : ""}` : "Sorted by store aisle"}
              right={<Button small title="Add week" icon="calendar-outline" kind="soft" onPress={addWeek} />} />
            <View style={s.row}>
              <TextInput ref={input} style={[s.input, { flex: 1 }]} value={text} onChangeText={setText} placeholder="Add an item, e.g. 2 lemons"
                placeholderTextColor={C.muted} returnKeyType="done" onSubmitEditing={submit} blurOnSubmit={false} />
              <Button title="Add" kind="primary" onPress={submit} />
            </View>
          </View>
        }
        ListEmptyComponent={<Empty text={"Your list is empty.\nTap Add week to add ingredients for your planned meals, or open any recipe and add its ingredients."} />}
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 20, marginBottom: 6 }}>
            <Text style={{ flex: 1, fontSize: 13, fontWeight: "800", color: C.muted, letterSpacing: 0.6 }}>{section.title.toUpperCase()}</Text>
            {section.done ? <Button small title={`Clear ${done.length}`} icon="trash-outline" onPress={P.clearChecked} /> : null}
          </View>
        )}
        renderItem={({ item: it, index, section }) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 11, backgroundColor: C.card,
            borderColor: C.border, borderWidth: 1, borderTopWidth: index === 0 ? 1 : 0,
            borderTopLeftRadius: index === 0 ? 14 : 0, borderTopRightRadius: index === 0 ? 14 : 0,
            borderBottomLeftRadius: index === section.data.length - 1 ? 14 : 0, borderBottomRightRadius: index === section.data.length - 1 ? 14 : 0 }}>
            <Pressable onPress={() => { tap(); P.toggleItem(it.uid); }} hitSlop={8} accessibilityLabel={`${it.checked ? "Uncheck" : "Check off"} ${it.name}`}>
              <Ionicons name={it.checked ? "checkmark-circle" : "ellipse-outline"} size={28} color={it.checked ? C.green : C.ghostDark} />
            </Pressable>
            <Pressable style={{ flex: 1 }} onPress={() => { tap(); P.toggleItem(it.uid); }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: it.checked ? C.muted : C.text, textDecorationLine: it.checked ? "line-through" : "none" }}>
                {it.name}{it.qty ? <Text style={{ fontWeight: "400", color: C.muted }}>{"  — " + it.qty}</Text> : null}
              </Text>
              {it.meals && it.meals.length ? <Text style={[s.muted, s.small]} numberOfLines={1}>for {it.meals.join(", ")}</Text> : null}
            </Pressable>
            <Pressable onPress={() => { tap(); P.removeItem(it.uid); }} hitSlop={10} accessibilityLabel={`Remove ${it.name}`}>
              <Ionicons name="close" size={20} color={C.muted} />
            </Pressable>
          </View>
        )}
      />
      <IngredientsSheet visible={weekOpen} onClose={() => setWeekOpen(false)} />
    </SafeAreaView>
  );
}
