// This Week: the Saturday-to-Friday dinner plan, with sides, last week, sending and shopping.
import React, { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { MP, usePlanner } from "../../lib/planner";
import { Button, C, Empty, MealPhoto, Segmented, Title, s, tap } from "../../components/ui";
import { IngredientsSheet, PickerSheet, RecipeSheet, ShareSheet } from "../../components/sheets";

export default function WeekScreen() {
  const P = usePlanner();
  const d = P.S.data;
  const [viewingLast, setViewingLast] = useState(false);
  const [recipe, setRecipe] = useState(null);
  const [picker, setPicker] = useState(null);
  const [shareText, setShareText] = useState(null);
  const [shopping, setShopping] = useState(false);
  const lw = P.lastWeek();
  const range = viewingLast ? (lw ? MP.dateRange(lw.start) : "") : MP.dateRange(d.week_start);

  const nextWeek = () => {
    if (!d.week.some(Boolean)) return P.startNextWeek();
    Alert.alert("Start next week?", "This week's plan moves to Last week and you get a fresh menu. Nothing from this week will be repeated.",
      [{ text: "Cancel", style: "cancel" }, { text: "Start next week", onPress: P.startNextWeek }]);
  };
  const share = () => {
    const src = viewingLast && lw ? lw : d;
    setShareText(MP.weekText(src, viewingLast && lw ? lw.start : d.week_start));
  };

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={s.pad}>
        <Title title={P.weekTitle(viewingLast)} subtitle={range} right={P.S.family ? <SyncBadge /> : null} />
        <Segmented options={[[true, "◀ Last week"], [false, "This week"]]} value={viewingLast} onChange={setViewingLast} style={{ marginBottom: 12 }} />
        {viewingLast ? <LastWeek lw={lw} onOpen={setRecipe} onShare={share} /> : (
          <>
            <View style={[s.row, { marginBottom: 8 }]}>
              <Button title="Shuffle week" icon="shuffle" kind="primary" flex onPress={() => P.shuffleWeek()} />
              <Button icon="paper-plane-outline" kind="soft" onPress={share} />
              <Button icon="cart-outline" kind="soft" onPress={() => {
                if (!d.week.some(Boolean)) return P.notify("Plan some meals first");
                setShopping(true);
              }} />
              <Button icon="play-skip-forward-outline" onPress={nextWeek} />
            </View>
            <Segmented options={MP.SOURCES.map(([k, l]) => [k, l])} value={d.source} onChange={P.setSource} />
            <Text style={[s.muted, s.small, { marginVertical: 10 }]}>Nothing from last week is repeated. Swap changes one day; Keep holds a day when you shuffle.</Text>
            {MP.DAYS.map((day, i) => (
              <DayCard key={day} i={i} day={day} onOpen={setRecipe} onPick={(side) => {
                if (side && !d.favorites.some((f) => MP.mealTypes(f).has("sides"))) {
                  return P.notify("None of your favorites are tagged Side yet — tap a meal's Side tag on Favorites");
                }
                if (!d.favorites.length) return P.notify("Add some Favorites first");
                setPicker({ day: i, side });
              }} />
            ))}
          </>
        )}
      </ScrollView>
      <RecipeSheet meal={recipe} onClose={() => setRecipe(null)} />
      <PickerSheet target={picker} onClose={() => setPicker(null)} />
      <ShareSheet text={shareText} onClose={() => setShareText(null)} />
      <IngredientsSheet visible={shopping} onClose={() => setShopping(false)} />
    </SafeAreaView>
  );
}

function SyncBadge() {
  const P = usePlanner();
  const st = P.S.syncState;
  const [name, color] = st === "ok" ? ["cloud-done-outline", C.green] : st === "error" ? ["cloud-offline-outline", C.accentDark] : ["cloud-outline", C.muted];
  return <Ionicons name={name} size={22} color={color} accessibilityLabel={`Sync: ${st}`} />;
}

function DayCard({ i, day, onOpen, onPick }) {
  const P = usePlanner();
  const d = P.S.data;
  const meal = d.week[i], kept = d.kept[i], side = d.sides[i];
  const date = MP.addDays(MP.parseIso(d.week_start), i);
  const isToday = MP.isoDate(date) === MP.isoDate(new Date());
  const headBg = kept ? C.green : isToday ? C.accent : C.ghost;
  const headFg = kept || isToday ? "#fff" : C.text;
  const saved = meal && P.isFavorite(meal.name);
  return (
    <View style={[s.card, { marginBottom: 12, borderWidth: 2, borderColor: kept ? C.green : isToday ? C.accent : C.border }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: headBg }}>
        <Text style={{ fontWeight: "800", color: headFg }}>{day}</Text>
        <Text style={{ fontSize: 12, color: headFg, opacity: 0.9 }}>{isToday ? "today" : MP.shortDate(date)}{kept ? "  ·  kept" : ""}</Text>
      </View>
      {meal ? (
        <>
          <Pressable style={{ flexDirection: "row", gap: 12, padding: 12, alignItems: "center" }} onPress={() => { tap(); onOpen(meal); }}>
            <MealPhoto meal={meal} style={{ width: 86, height: 86, borderRadius: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }} numberOfLines={2}>{meal.name}</Text>
              <Text style={[s.muted, s.small, { marginTop: 3 }]}>{meal.origin === "Favorite" ? "♥ Favorite" : "✨ New idea"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.muted} />
          </Pressable>
          <View style={[s.row, { paddingHorizontal: 12, paddingBottom: 12, flexWrap: "wrap" }]}>
            <Button small title="Swap" icon="swap-horizontal" kind="primary" onPress={() => P.swapDay(i)} />
            <Button small title="Choose" icon="list" onPress={() => onPick(false)} />
            <Button small title={saved ? "Saved" : "Save"} icon={saved ? "heart" : "heart-outline"} kind={saved ? "done" : "soft"}
              disabled={saved} onPress={() => P.addFavorite(meal)} />
            <Button small title={kept ? "Kept" : "Keep"} icon={kept ? "lock-closed" : "lock-open-outline"} kind={kept ? "done" : "ghost"}
              onPress={() => P.toggleKeep(i)} style={kept && { backgroundColor: C.green }} />
          </View>
          <View style={{ marginHorizontal: 12, marginBottom: 12, backgroundColor: C.ghost, borderRadius: 10, padding: 8 }}>
            {side ? (
              <>
                <Pressable style={{ flexDirection: "row", alignItems: "center", gap: 10 }} onPress={() => { tap(); onOpen(side); }}>
                  <MealPhoto meal={side} style={{ width: 42, height: 42, borderRadius: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10, fontWeight: "800", color: C.muted, letterSpacing: 0.6 }}>SIDE</Text>
                    <Text style={{ color: C.text }} numberOfLines={2}>{side.name}</Text>
                  </View>
                </Pressable>
                <View style={[s.row, { marginTop: 8 }]}>
                  <Button small title="Random" icon="shuffle" kind="soft" onPress={() => P.randomSide(i)} />
                  <Button small title="Pick" icon="list" onPress={() => onPick(true)} />
                  <Button small title="Remove" icon="close" onPress={() => P.removeSide(i)} style={{ backgroundColor: "transparent" }} />
                </View>
              </>
            ) : (
              <View style={s.row}>
                <Button small title="Random side" icon="add" kind="soft" flex onPress={() => P.randomSide(i)} />
                <Button small title="Pick a side" icon="list" flex onPress={() => onPick(true)} />
              </View>
            )}
          </View>
        </>
      ) : (
        <View style={{ padding: 12, gap: 10 }}>
          <Text style={s.muted}>Nothing planned yet</Text>
          <View style={s.row}>
            <Button small title="Pick random" icon="shuffle" kind="primary" flex onPress={() => P.swapDay(i)} />
            <Button small title="Choose a favorite" icon="list" flex onPress={() => onPick(false)} />
          </View>
        </View>
      )}
    </View>
  );
}

function LastWeek({ lw, onOpen, onShare }) {
  if (!lw) return <Empty text={"No previous week yet.\nWhen a new week starts (or you tap Next week), this week's plan moves here."} />;
  const start = MP.parseIso(lw.start);
  return (
    <>
      <Button title="Send last week's menu" icon="paper-plane-outline" kind="soft" onPress={onShare} style={{ marginBottom: 12 }} />
      {MP.DAYS.map((day, i) => {
        const meal = lw.week[i], side = lw.sides[i];
        return (
          <Pressable key={day} disabled={!meal} onPress={() => onOpen(meal)} style={[s.card, { flexDirection: "row", gap: 12, padding: 10, marginBottom: 10, alignItems: "center" }]}>
            <MealPhoto meal={meal || { name: "-" }} style={{ width: 64, height: 64, borderRadius: 9 }} />
            <View style={{ flex: 1 }}>
              <Text style={[s.muted, s.small]}>{day} · {MP.shortDate(MP.addDays(start, i))}</Text>
              <Text style={{ fontWeight: "700", color: C.text }} numberOfLines={2}>{meal ? meal.name : "Nothing planned"}</Text>
              {side ? <Text style={[s.muted, s.small]} numberOfLines={1}>+ {side.name}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </>
  );
}
