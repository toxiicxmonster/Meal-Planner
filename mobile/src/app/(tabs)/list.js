// Shopping list: grouped by aisle, tap to check off, quick-add, add the week's ingredients.
import React, { useRef, useState } from "react";
import { Pressable, SectionList, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MP, usePlanner } from "../../lib/planner";
import { Button, C, Empty, Sheet, Title, s, tap } from "../../components/ui";
import { IngredientsSheet } from "../../components/sheets";

/** A round − or + button for an item's amount. */
function StepButton({ icon, label, onPress }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? C.accentSoft : "transparent" })}>
      <Ionicons name={icon} size={18} color={C.text} />
    </Pressable>
  );
}

export default function ListScreen() {
  const P = usePlanner();
  const [text, setText] = useState("");
  const [weekOpen, setWeekOpen] = useState(false);
  const [aisleFor, setAisleFor] = useState(null); // the item whose aisle is being picked
  const [typedAisle, setTypedAisle] = useState("");
  const pickAisle = (it) => { setTypedAisle(MP.AISLES.includes(it.aisle || "Other") ? "" : it.aisle); setAisleFor(it); };
  const applyTypedAisle = () => {
    const name = MP.cleanAisle(typedAisle, P.S.data);
    if (!name || !aisleFor) return;
    P.setItemAisle(aisleFor.uid, name);
    setAisleFor(null);
  };
  const input = useRef(null);
  const items = P.S.data.shopping;
  const toBuy = items.filter((it) => !it.checked), done = items.filter((it) => it.checked);
  const sections = MP.listAisles(toBuy)
    .map((aisle) => ({ title: MP.aisleLabel(aisle), data: toBuy.filter((it) => (it.aisle || "Other") === aisle).sort((a, b) => a.name.localeCompare(b.name)) }))
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
                {it.name}{it.checked && it.qty ? <Text style={{ fontWeight: "400", color: C.muted }}>{"  — " + it.qty}</Text> : null}
              </Text>
              {it.meals && it.meals.length ? <Text style={[s.muted, s.small]} numberOfLines={1}>for {it.meals.join(", ")}</Text> : null}
            </Pressable>
            {it.checked ? null : (
              <View style={{ alignItems: "flex-end", gap: 6, maxWidth: "46%" }}>
                <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: C.ghost, borderRadius: 18, padding: 2 }}
                  accessibilityLabel={`How many ${it.name}`}>
                  <StepButton icon="remove" label={`Less ${it.name}`} onPress={() => P.stepItem(it.uid, -1)} />
                  <Text style={{ minWidth: 22, paddingHorizontal: 2, textAlign: "center", fontSize: 15, fontWeight: it.qty ? "700" : "500",
                    color: it.qty ? C.text : C.muted }} numberOfLines={2}>{it.qty || "1"}</Text>
                  <StepButton icon="add" label={`More ${it.name}`} onPress={() => P.stepItem(it.uid, 1)} />
                </View>
                <Pressable hitSlop={6} onPress={() => { tap(); pickAisle(it); }} accessibilityRole="button"
                  accessibilityLabel={`Choose the aisle for ${it.name}`}
                  style={(it.aisle || "Other") === "Other" ? { backgroundColor: C.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 } : null}>
                  <Text style={{ fontSize: 12, fontWeight: "600", color: (it.aisle || "Other") === "Other" ? C.accentDark : C.muted }}>
                    {(it.aisle || "Other") === "Other" ? "Choose aisle ▾" : "Move ▾"}
                  </Text>
                </Pressable>
              </View>
            )}
            <Pressable onPress={() => { tap(); P.removeItem(it.uid); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${it.name}`}
              style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.accentSoft : "transparent" })}>
              <Ionicons name="close" size={20} color={C.muted} />
            </Pressable>
          </View>
        )}
      />
      <Sheet visible={!!aisleFor} onClose={() => setAisleFor(null)} title={aisleFor ? `Which aisle is “${aisleFor.name}” in?` : ""}>
        <Text style={[s.muted, { marginBottom: 12 }]}>The list remembers this, so it goes there every time.</Text>
        <View style={[s.row, { marginBottom: 14 }]}>
          <TextInput style={[s.input, { flex: 1 }]} value={typedAisle} onChangeText={setTypedAisle} maxLength={30}
            placeholder="Type an aisle, e.g. A21 or Outdoors" placeholderTextColor={C.muted} autoCorrect={false}
            returnKeyType="done" onSubmitEditing={applyTypedAisle} />
          <Button title="Use" kind="primary" disabled={!typedAisle.trim()} onPress={applyTypedAisle} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {MP.aisleChoices(P.S.data).map((a) => {
            const on = aisleFor && (aisleFor.aisle || "Other") === a;
            return <Button key={a} title={(on ? "✓ " : "") + a} kind={on ? "primary" : "ghost"} style={{ width: "48%" }}
              onPress={() => { P.setItemAisle(aisleFor.uid, a); setAisleFor(null); }} />;
          })}
        </View>
      </Sheet>
      <IngredientsSheet visible={weekOpen} onClose={() => setWeekOpen(false)} />
    </SafeAreaView>
  );
}
