/**
 * カードのタグを「既存タグから選ぶ」入力。
 *
 * 自由入力の1行テキストだと既存のタグが見えず、似た綴りのタグが増える。候補（デッキ内で
 * 使われているタグ・件数順）をチップで並べ、タップで付け外しする。候補が多いデッキ向けに
 * 絞り込みの入力欄を置く。
 *
 * 新しいタグは、絞り込み欄に打っただけでは作らない。「“xxx” を新しいタグとして追加」を
 * 押したときだけ作る（`allowNew` が false なら出さない。xlsx から生成するデッキは
 * 体系にあるタグしか戻せないため）。
 */
import { useState } from "react";
import { toggleTag, type TagCount } from "./deckedit";

interface TagPickerProps {
  /** 選択中のタグ（順序も保つ） */
  value: string[];
  /** 候補。`collectDeckTags` の結果を渡す */
  options: TagCount[];
  onChange: (tags: string[]) => void;
  /** 候補に無いタグを新しく作れるか */
  allowNew: boolean;
  disabled?: boolean;
}

/** 絞り込み欄に出しておく候補の上限。数十個を超えるデッキで画面が埋まらないようにする */
const MAX_VISIBLE_OPTIONS = 30;

export function TagPicker({ value, options, onChange, allowNew, disabled = false }: TagPickerProps) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const matching = options.filter((option) => !value.includes(option.tag) && (lower === "" || option.tag.toLowerCase().includes(lower)));
  const visible = matching.slice(0, MAX_VISIBLE_OPTIONS);
  const exists = value.includes(trimmed) || options.some((option) => option.tag === trimmed);
  const canCreate = allowNew && trimmed !== "" && !exists;

  function add(tag: string) {
    onChange(toggleTag(value, tag));
    setQuery("");
  }

  return (
    <div className="tag-picker" aria-label="タグ">
      {value.length > 0 && (
        <div className="tag-picker-selected" role="group" aria-label="選択中のタグ">
          {value.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag-chip tag-chip-selected"
              disabled={disabled}
              onClick={() => onChange(toggleTag(value, tag))}
              aria-label={`タグ「${tag}」を外す`}
            >
              {tag}
              <span aria-hidden="true"> ×</span>
            </button>
          ))}
        </div>
      )}
      <input
        type="search"
        className="tag-picker-search"
        value={query}
        placeholder={options.length > 0 ? "タグを検索" : allowNew ? "新しいタグ" : "タグはありません"}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="タグを検索"
      />
      <div className="tag-picker-options" role="group" aria-label="タグの候補">
        {visible.map((option) => (
          <button
            key={option.tag}
            type="button"
            className="tag-chip tag-chip-option"
            disabled={disabled}
            onClick={() => add(option.tag)}
            aria-label={`タグ「${option.tag}」を付ける（${option.count}枚）`}
          >
            {option.tag}
            <span className="tag-chip-count" aria-hidden="true">
              {option.count}
            </span>
          </button>
        ))}
        {matching.length > visible.length && <span className="tag-picker-more">…ほか {matching.length - visible.length} 件。絞り込んでください</span>}
        {canCreate && (
          <button type="button" className="tag-chip tag-chip-create" disabled={disabled} onClick={() => add(trimmed)}>
            “{trimmed}” を新しいタグとして追加
          </button>
        )}
        {!allowNew && trimmed !== "" && matching.length === 0 && !value.includes(trimmed) && (
          <span className="tag-picker-more">このデッキでは既存のタグからだけ選べます</span>
        )}
      </div>
    </div>
  );
}
