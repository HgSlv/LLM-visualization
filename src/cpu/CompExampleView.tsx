import React, { useEffect } from "react";
import { useEditorContext } from "./Editor";
import s from "./CompExampleView.module.scss";
import { IElfTextSection, listElfTextSections, readElfHeader } from "./ElfParser";
import { ICompDataRom } from "./comps/SimpleMemory";
import { IExeComp } from "./CpuModel";
import { ICompDataRegFile, ICompDataSingleReg } from "./comps/Registers";
import { stepExecutionCombinatorial, stepExecutionLatch } from "./CpuExecution";
import { ensureSigned32Bit } from "./comps/RiscvInsDecode";

interface IExampleEntry {
    name: string;
    elfSection: IElfTextSection;
    expectFail: boolean;
}

export const CompExampleView: React.FC = () => {
    let { editorState, setEditorState, exeModel } = useEditorContext();

    let [examples, setExamples] = React.useState<IExampleEntry[]>([]);

    useEffect(() => {
        let basePath = (process.env.BASE_URL ?? '') + '/riscv/examples/';

        async function run() {
            let resp = await fetch(basePath + 'add_tests');

            if (resp.ok) {
                let elfFile = new Uint8Array(await resp.arrayBuffer());

                let header = readElfHeader(elfFile)!;
                let sections = listElfTextSections(elfFile, header);

                let examples = sections.map(section => {
                    // name is '.text_add0', and we want 'add0'
                    let name = section.name.slice(6);
                    return {
                        name,
                        elfSection: section,
                        expectFail: name.startsWith('must_fail'),
                    };
                });

                setExamples(examples);
            }
        }

        run();

    }, []);

    function handleEntryClick(example: IExampleEntry) {
        loadEntryData(example);
        stepExecutionCombinatorial(exeModel);
        setEditorState(a => ({ ...a }));
    }

    function onStepClicked() {
        // console.log('--- running execution (latching followed by steps) ---', exeModel);
        if (!exeModel.runArgs.halt) {
            stepExecutionLatch(exeModel);
        }

        if (!exeModel.runArgs.halt) {
            stepExecutionCombinatorial(exeModel);
        }

        setEditorState(a => ({ ...a }));
    }

    function loadEntryData(example: IExampleEntry) {
        let romComp = getRomComp();
        if (romComp) {
            let romArr = romComp.data.rom;
            romArr.set(example.elfSection.arr);
            romArr.fill(0, example.elfSection.arr.length);
        }
    }

    function resetRegs() {
        let pcComp = getPcComp();
        let regComp = getRegsComp();

        if (pcComp && regComp) {
            pcComp.data.value = 0;
            for (let i = 0; i < regComp.data.file.length; i++) {
                regComp.data.file[i] = 0;
            }
        } else {
            console.log('could not find pc or reg comp');
        }
    }

    function onRunAllTestsClicked() {
        console.log('Running all tests...');
        let startTime = performance.now();
        let successCount = 0;
        let totalCount = 0;
        let insCount = 0;
        let repeatCount = 0;
        for (; repeatCount < 100 && successCount === totalCount; repeatCount++) {
            for (let test of examples) {
                loadEntryData(test);
                resetRegs();
                stepExecutionCombinatorial(exeModel);

                totalCount += 1;
                let completed = false;

                for (let i = 0; i < 200; i++) {
                    if (exeModel.runArgs.halt) {
                        let regs = getRegsComp();
                        let resRegValue = regs?.data.file[10] ?? 0;
                        let testNumValue = regs?.data.file[11] ?? 0;

                        if (resRegValue !== 44 && resRegValue !== 911) {
                            console.log(`--- test '${test.name}' halted with unknown result in reg[a0]: ${ensureSigned32Bit(resRegValue)} ---`);
                        } else {
                            let isSuccess = (resRegValue === 44) !== test.expectFail;

                            if (isSuccess) {
                                successCount += 1;
                                // console.log(`--- halted with success ---`);
                            } else {
                                console.log(`--- test '${test.name}' halted with FAILURE (test ${testNumValue}) ---`);
                            }
                        }
                        completed = true;
                        break;
                    }

                    insCount += 1;
                    stepExecutionLatch(exeModel);
                    stepExecutionCombinatorial(exeModel);
                }

                if (!completed) {
                    console.log(`--- test '${test.name}' halted after too many instructions ---`);
                }
            }
        }
        let endTime = performance.now();
        let timeMs = endTime - startTime;
        console.log(`All tests done in ${timeMs.toFixed(1)}ms. Success: ${successCount}/${totalCount} (repeats=${repeatCount}). Instructions: ${insCount} (${(insCount / timeMs).toFixed(0)} kHz)`);
    }

    function findCompByDefId(defId: string) {
        return exeModel.comps.find(comp => comp.comp.defId === defId);
    }

    function getPcComp() {
        return findCompByDefId('reg1') as IExeComp<ICompDataSingleReg> | undefined;
    }
    function getRegsComp() {
        return findCompByDefId('reg32Riscv') as IExeComp<ICompDataRegFile> | undefined;
    }
    function getRomComp() {
        return findCompByDefId('rom0') as IExeComp<ICompDataRom> | undefined;
    }

    function onResetClicked() {
        resetRegs();
        stepExecutionCombinatorial(exeModel);
        setEditorState(a => ({ ...a }));
    }

    return <div className={s.exampleView}>
        <div className={s.header}>Examples</div>

        <div className={s.body}>
            {examples.map((example, idx) => {

                return <div
                    className={s.entry}
                    onClick={() => handleEntryClick(example)}
                    key={idx}
                >{example.name}</div>;
            })}
        </div>

        <div className={s.divider} />

        <div className={s.body}>
            <button className={s.btn} disabled={exeModel.runArgs.halt} onClick={onStepClicked}>Step</button>
            <button className={s.btn} onClick={onResetClicked}>Reset</button>
            <button className={s.btn} onClick={onRunAllTestsClicked}>Run all</button>
        </div>

    </div>;
};