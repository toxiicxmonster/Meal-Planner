// The sheets that slide up over a screen.
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, Share, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { usePlanner, MP } from "../lib/planner";
import { Button, C, Empty, MealPhoto, Sheet, s, tap } from "./ui";

const SKIP = new Set(["water", "cold water", "hot water", "boiling water", "warm water", "ice"]);

function CheckRow({ checked, onPress, label, sub }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={{ flexDirection: "row", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border }}>
      <Ionicons name={checked ? "checkbox" : "square-outline"} size={22} color={checked ? C.accent : C.ghostDark} />
      <Text style={[s.body, { flex: 1 }]}>{label}{sub ? <Text style={s.muted}>{"  — " + sub}</Text> : null}</Text>
    </Pressable>
  );
}

/** Ingredients of one or more meals as a checklist; returns [rows, adds, toggle]. */
function useChecklist(meals) {
  const P = usePlanner();
  const rows = useMemo(() => meals.map(([label, meal]) => ({
    label, meal, parts: MP.mealParts(P.fullMeal(meal), P.S.details),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [meals]);
  const [unchecked, setUnchecked] = useState(() => {
    const off = new Set();
    rows.forEach((r, i) => r.parts.forEach((p, j) => { if (SKIP.has(p.n.trim().toLowerCase())) off.add(i + ":" + j); }));
    return off;
  });
  const toggle = (key) => setUnchecked((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const adds = [];
  rows.forEach((r, i) => r.parts.forEach((p, j) => { if (!unchecked.has(i + ":" + j)) adds.push({ name: p.n, qty: p.q, meal: r.meal.name }); }));
  return [rows, adds, unchecked, toggle];
}

function Checklist({ rows, unchecked, toggle, showTitles }) {
  return rows.map((r, i) => (
    <View key={i} style={{ marginBottom: 8 }}>
      {showTitles ? <Text style={[s.h2, { fontSize: 16, marginTop: 14, marginBottom: 2 }]}>{r.label ? `${r.label}: ` : ""}{r.meal.name}</Text> : null}
      {r.parts.length ? r.parts.map((p, j) => (
        <CheckRow key={j} checked={!unchecked.has(i + ":" + j)} onPress={() => toggle(i + ":" + j)} label={p.n} sub={p.q} />
      )) : <Text style={[s.muted, { paddingVertical: 6 }]}>No ingredients saved for this meal.</Text>}
    </View>
  ));
}

// ---------------------------------------------------------------- loading recipes live

/** Shown while recipes' ingredients and instructions load live from TheMealDB. */
function LoadingSheet({ meals, title, onClose }) {
  const P = usePlanner();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  React.useEffect(() => {
    let alive = true;
    P.loadDetails(meals).then(() => { if (alive && meals.some(P.needsDetails)) setFailed(true); });
    return () => { alive = false; };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet visible onClose={onClose} title={title}>
      {failed ? (
        <View style={{ alignItems: "center", paddingVertical: 40, gap: 14 }}>
          <Text style={s.muted}>Couldn’t load the recipe. Check your connection.</Text>
          <Button title="Try again" kind="primary" onPress={() => { setFailed(false); setAttempt((n) => n + 1); }} />
        </View>
      ) : <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------- recipe

export function RecipeSheet({ meal, onClose }) {
  const P = usePlanner();
  if (!meal) return <Sheet visible={false} onClose={onClose} title="" />;
  if (P.needsDetails(meal)) return <LoadingSheet meals={[meal]} title={meal.name} onClose={onClose} />;
  const m = P.fullMeal(meal);
  return <RecipeContent key={m.name} meal={m} onClose={onClose} />;
}

function AddButton({ adds, onAdd }) {
  return <Button kind="primary" icon="cart-outline" title={adds.length ? `Add ${adds.length} to shopping list` : "Add to shopping list"}
    onPress={onAdd} disabled={!adds.length} />;
}

function RecipeContent({ meal, onClose }) {
  const P = usePlanner();
  const meals = useMemo(() => [["", meal]], [meal]);
  const [rows, adds, unchecked, toggle] = useChecklist(meals);
  const saved = P.isFavorite(meal.name);
  const sub = [meal.category, meal.area].filter(Boolean).join(" · ");
  const hasParts = rows[0].parts.length > 0;
  return (
    <Sheet visible onClose={onClose} title={meal.name}
      footer={hasParts ? <AddButton adds={adds} onAdd={() => { P.addIngredients(adds); onClose(); }} /> : null}>
      {meal.thumb ? <MealPhoto meal={meal} big style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 14, marginBottom: 12 }} /> : null}
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
      <View style={[s.wrap, { marginTop: 12 }]}>
        <Button title={saved ? "♥ Saved" : "♡ Save"} kind={saved ? "done" : "soft"} disabled={saved} onPress={() => P.addFavorite(meal)} />
        {meal.url ? <Button title="Full recipe" icon="open-outline" onPress={() => Linking.openURL(meal.url)} /> : null}
        {meal.youtube ? <Button title="Video" icon="logo-youtube" onPress={() => Linking.openURL(meal.youtube)} /> : null}
      </View>
      {hasParts ? (
        <>
          <Text style={s.h3}>Ingredients</Text>
          <Text style={[s.muted, s.small, { marginBottom: 4 }]}>Tick what you need, then add it to your shopping list.</Text>
          <Checklist rows={rows} unchecked={unchecked} toggle={toggle} />
        </>
      ) : null}
      {meal.instructions ? (<><Text style={s.h3}>Instructions</Text><Text style={s.body}>{meal.instructions.replace(/\r\n/g, "\n")}</Text></>) : null}
      {meal.notes ? (<><Text style={s.h3}>My notes</Text><Text style={s.body}>{meal.notes}</Text></>) : null}
      {!hasParts && !meal.instructions && !meal.notes
        ? <Text style={[s.muted, { marginTop: 16 }]}>No recipe details saved for this meal. Add a recipe link or notes from Favorites.</Text> : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- add the week's ingredients

export function IngredientsSheet({ visible, onClose }) {
  const P = usePlanner();
  if (!visible) return <Sheet visible={false} onClose={onClose} title="" />;
  const meals = P.plannedMeals().map(([, m]) => m);
  if (meals.some(P.needsDetails)) return <LoadingSheet meals={meals} title="Add this week to your list" onClose={onClose} />;
  return <WeekIngredients onClose={onClose} />;
}

function WeekIngredients({ onClose }) {
  const P = usePlanner();
  const meals = useMemo(() => P.plannedMeals(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, adds, unchecked, toggle] = useChecklist(meals);
  return (
    <Sheet visible onClose={onClose} title="Add this week to your list"
      footer={meals.length ? <AddButton adds={adds} onAdd={() => { P.addIngredients(adds); onClose(); }} /> : null}>
      {!meals.length ? <Empty text="Plan some meals first." /> : (
        <View>
          <Text style={s.muted}>Untick anything you already have. Items already on your list are combined.</Text>
          <Checklist rows={rows} unchecked={unchecked} toggle={toggle} showTitles />
        </View>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- choose a favorite for a day

export function PickerSheet({ target, onClose }) {
  const P = usePlanner();
  const [q, setQ] = useState("");
  const side = target && target.side;
  const favs = P.S.data.favorites.filter((m) => !side || MP.mealTypes(m).has("sides"))
    .filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const slot = target ? (side ? P.S.data.sides : P.S.data.week)[target.day] : null;
  const current = slot ? slot.name.toLowerCase() : "";
  const lw = P.lastWeekNames();
  return (
    <Sheet visible={!!target} onClose={() => { setQ(""); onClose(); }}
      title={target ? `Choose a ${side ? "side" : "dinner"} for ${MP.DAYS[target.day]}` : ""}>
      <Text style={s.muted}>{side ? "Only favorites tagged Side are shown." : "It will be marked Keep so shuffling won't replace it."}</Text>
      <TextInput style={[s.input, { marginVertical: 12 }]} placeholder="Filter favorites…" value={q} onChangeText={setQ}
        placeholderTextColor={C.muted} clearButtonMode="while-editing" />
      {!favs.length ? <Empty text={side ? "None of your favorites are tagged Side yet.\nTap a meal's Side tag on the Favorites tab." : "No matches."} /> : null}
      <View style={s.wrap}>
        {favs.map((m) => (
          <Pressable key={m.uid} style={[s.card, { width: "48%" }, m.name.toLowerCase() === current && { borderColor: C.accent, borderWidth: 2 }]}
            onPress={() => { tap(); P.pickFavorite(target.day, m.uid, side); setQ(""); onClose(); }}>
            <MealPhoto meal={m} style={{ width: "100%", aspectRatio: 4 / 3 }} />
            <View style={{ padding: 8 }}>
              <Text style={{ fontWeight: "700", color: C.text }} numberOfLines={2}>{m.name}{m.name.toLowerCase() === current ? " ✓" : ""}</Text>
              {lw.has(m.name.toLowerCase()) ? <Text style={[s.muted, s.small, { fontStyle: "italic" }]}>Had it last week</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- add / edit a favorite

export function EditorSheet({ target, onClose }) {
  // target: undefined = closed, {uid: null} = new meal, {uid} = edit
  return (
    <Sheet visible={!!target} onClose={onClose} title={target && target.uid ? "Edit meal" : "Add a meal"}>
      {target ? <EditorForm key={target.uid || "new"} uid={target.uid} startType={target.type} onClose={onClose} /> : null}
    </Sheet>
  );
}

function EditorForm({ uid, startType, onClose }) {
  const P = usePlanner();
  const existing = uid ? P.favByUid(uid) : null;
  const [name, setName] = useState(existing ? existing.name : "");
  const [types, setTypes] = useState(() => [...(existing ? MP.mealTypes(existing) : new Set([startType || "dinner"]))]);
  const [url, setUrl] = useState(existing ? existing.url || "" : "");
  const [thumb, setThumb] = useState(existing ? existing.thumb || "" : "");
  const [notes, setNotes] = useState(existing ? existing.notes || "" : "");
  const [error, setError] = useState(null);
  const toggle = (k) => setTypes((t) => (t.includes(k) ? t.filter((x) => x !== k) : t.concat(k)));
  return (
    <View>
      <Text style={s.label}>Meal name</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. Tacos" placeholderTextColor={C.muted} autoFocus={!existing} />
      <Text style={s.label}>Categories <Text style={[s.muted, { fontWeight: "400" }]}>(tick all that apply)</Text></Text>
      <View style={s.wrap}>
        {MP.TYPE_TAGS.map(([k, l]) => (
          <Pressable key={k} onPress={() => { tap(); toggle(k); }} style={[s.chip, types.includes(k) && { backgroundColor: C.accentSoft, borderColor: C.accentSoft }]}>
            <Text style={[s.chipText, types.includes(k) && { color: C.accentDark }]}>{types.includes(k) ? "✓ " : ""}{l}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.label}>Recipe link <Text style={[s.muted, { fontWeight: "400" }]}>(optional)</Text></Text>
      <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="url" />
      <Text style={s.label}>Photo link <Text style={[s.muted, { fontWeight: "400" }]}>(optional)</Text></Text>
      <TextInput style={s.input} value={thumb} onChangeText={setThumb} placeholder="Paste an image address" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="url" />
      <Text style={s.label}>Notes</Text>
      <TextInput style={[s.input, { minHeight: 90, textAlignVertical: "top" }]} value={notes} onChangeText={setNotes} multiline />
      {error ? <Text style={{ color: C.accentDark, marginTop: 12, fontWeight: "600" }}>{error}</Text> : null}
      <View style={[s.row, { marginTop: 18 }]}>
        {existing ? <Button title="Remove" icon="trash-outline" kind="danger" onPress={() => { P.removeFavorite(uid); onClose(); }} /> : null}
        <Button title="Save meal" kind="primary" flex onPress={() => {
          const err = P.saveFavorite({ name, types, url, thumb, notes }, uid);
          if (err) setError(err); else onClose();
        }} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- send the menu

export function ShareSheet({ text, onClose }) {
  if (!text) return <Sheet visible={false} onClose={onClose} title="" />;
  return <ShareContent key={text} text={text} onClose={onClose} />;
}

function ShareContent({ text, onClose }) {
  const [msg, setMsg] = useState(text);
  const P = usePlanner();
  return (
    <Sheet visible onClose={onClose} title="Send the menu">
      <Text style={s.muted}>You can edit the message first.</Text>
      <TextInput style={[s.input, { minHeight: 200, marginTop: 12, textAlignVertical: "top" }]} value={msg} onChangeText={setMsg} multiline />
      <View style={{ gap: 10, marginTop: 16 }}>
        <Button kind="primary" icon="share-outline" title="Share… (Messages, Messenger, more)" onPress={() => Share.share({ message: msg }).catch(() => {})} />
        <Button icon="chatbubble-outline" title="Text message" onPress={() =>
          Linking.openURL((Platform.OS === "ios" ? "sms:&body=" : "sms:?body=") + encodeURIComponent(msg)).catch(() => P.notify("Couldn't open Messages"))} />
        <Button icon="copy-outline" title="Copy" onPress={async () => { await Clipboard.setStringAsync(msg); P.notify("Menu copied"); }} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- pick a cuisine

function CuisineRow({ label, value, n, current, onPick }) {
  return (
    <Pressable onPress={() => { tap(); onPick(value); }}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.border }}>
      <Text style={[s.body, { flex: 1 }, current === value && { color: C.accentDark, fontWeight: "700" }]}>{label}</Text>
      {n ? <Text style={s.muted}>{n}</Text> : null}
      {current === value ? <Ionicons name="checkmark" size={18} color={C.accentDark} style={{ marginLeft: 8 }} /> : null}
    </Pressable>
  );
}

export function CuisineSheet({ visible, onClose }) {
  const P = usePlanner();
  const { regions, cuisines } = P.cuisineOptions();
  const current = P.S.data.filters.cuisine;
  const pick = (v) => { P.setCuisine(v); onClose(); };
  return (
    <Sheet visible={visible} onClose={onClose} title="Cuisine">
      <CuisineRow label="All cuisines" value={MP.ALL_CUISINES} current={current} onPick={pick} />
      <Text style={s.h3}>Regions</Text>
      {regions.map(([l, v, n]) => <CuisineRow key={v} label={l} value={v} n={n} current={current} onPick={pick} />)}
      <Text style={s.h3}>Cuisines</Text>
      {cuisines.map(([l, v, n]) => <CuisineRow key={v} label={l} value={v} n={n} current={current} onPick={pick} />)}
    </Sheet>
  );
}
