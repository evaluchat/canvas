import { useMemo } from "react";
import {
  BasicTextStyleButton,
  BlockTypeSelect,
  blockTypeSelectItems,
  CreateLinkButton,
  FormattingToolbar,
  NestBlockButton,
  UnnestBlockButton,
} from "@blocknote/react";
import { useDictionary } from "@blocknote/react";

function FormattingToolbarSeparator() {
  return (
    <div
      className="bn-w-px bn-self-stretch bn-bg-border bn-mx-0.5"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

export function CustomFormattingToolbar() {
  const dict = useDictionary();

  const essayBlockTypes = useMemo(
    // Paragraph, H1, H2, H3, bullet list, numbered list — exclude check list
    () => blockTypeSelectItems(dict).slice(0, 6),
    [dict]
  );

  return (
    <FormattingToolbar>
      <BlockTypeSelect items={essayBlockTypes} />
      <FormattingToolbarSeparator />
      <BasicTextStyleButton basicTextStyle="bold" key="boldStyleButton" />
      <BasicTextStyleButton basicTextStyle="italic" key="italicStyleButton" />
      <BasicTextStyleButton
        basicTextStyle="underline"
        key="underlineStyleButton"
      />
      <FormattingToolbarSeparator />
      <NestBlockButton key="nestBlockButton" />
      <UnnestBlockButton key="unnestBlockButton" />
      <CreateLinkButton key="createLinkButton" />
    </FormattingToolbar>
  );
}
