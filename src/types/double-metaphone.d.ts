declare module "double-metaphone" {
  function doubleMetaphone(str: string): [string | null, string | null];
  export = doubleMetaphone;
}
