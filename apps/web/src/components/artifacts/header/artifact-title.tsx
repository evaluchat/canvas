import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { useState, useRef, useEffect } from "react";

interface ArtifactTitleProps {
  title: string;
  isArtifactSaved: boolean;
  artifactUpdateFailed: boolean;
  onTitleChange?: (newTitle: string) => void;
}

export function ArtifactTitle(props: ArtifactTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(props.title);
  }, [props.title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSubmit = () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== props.title && props.onTitleChange) {
      props.onTitleChange(trimmed);
    } else {
      setEditValue(props.title);
    }
  };

  return (
    <div className="pl-[6px] pt-3 flex flex-col items-start justify-start ml-[6px] gap-1 max-w-1/2">
      {isEditing ? (
        <input
          ref={inputRef}
          className="text-xl font-medium text-gray-600 bg-transparent border-b border-gray-300 outline-none w-full max-w-md"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") {
              setEditValue(props.title);
              setIsEditing(false);
            }
          }}
        />
      ) : (
        <h1
          className="text-xl font-medium text-gray-600 line-clamp-1 cursor-text hover:text-gray-800"
          onClick={() => setIsEditing(true)}
          title="Click to edit title"
        >
          {props.title}
        </h1>
      )}
      <span className="mt-auto">
        {props.isArtifactSaved ? (
          <span className="flex items-center justify-start gap-1 text-gray-400">
            <p className="text-xs font-light">Saved</p>
            <CircleCheck className="w-[10px] h-[10px]" />
          </span>
        ) : !props.artifactUpdateFailed ? (
          <span className="flex items-center justify-start gap-1 text-gray-400">
            <p className="text-xs font-light">Saving</p>
            <LoaderCircle className="animate-spin w-[10px] h-[10px]" />
          </span>
        ) : props.artifactUpdateFailed ? (
          <span className="flex items-center justify-start gap-1 text-red-300">
            <p className="text-xs font-light">Failed to save</p>
            <CircleX className="w-[10px] h-[10px]" />
          </span>
        ) : null}
      </span>
    </div>
  );
}
