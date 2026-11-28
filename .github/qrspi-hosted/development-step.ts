import { developmentControl } from "./development-control.ts";
console.log(JSON.stringify(await developmentControl(process.argv[2])));
