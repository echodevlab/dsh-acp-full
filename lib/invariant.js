// src/invariant.ts
var PACKAGE_NAME = "dsh-acp-full";
var name = "dsh-acp-full-invariant";
var inject = ["invariants"];
var install = () => {};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  name,
  inject,
  apply
};

//# debugId=A004E8C80892466864756E2164756E21
